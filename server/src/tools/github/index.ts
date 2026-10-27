import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolContext } from "../../plugins";
import { createGitHubClient, validateRepo, type GitHubEnv } from "./auth";
export { createGitHubAppAuth, GitHubError, type GitHubEnv } from "./auth";

const clients = new WeakMap<object, ReturnType<typeof createGitHubClient>>();
const string = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const repoSchema = string(140);
const refSchema = string(200);
const shaSchema = Type.String({ pattern: "^[0-9a-f]{40}$" });
function ref(value: string): void {
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.split("/").some((p) => !p || p.startsWith(".") || p.endsWith(".") || p.endsWith(".lock"))
  )
    throw new Error("invalid_ref");
}
function path(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 500 ||
    !value ||
    /[\\\x00-\x1f\x7f%?#]/.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === ".." || p.toLowerCase() === ".git")
  )
    throw new Error("invalid_path");
  return value.split("/").map(encodeURIComponent).join("/");
}
function sha(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("invalid_sha");
}
function text(value: string, max: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0"))
    throw new Error("invalid_text");
}
function output(value: unknown) {
  return { output: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function create(context: ToolContext) {
  let client = clients.get(context.env);
  if (!client) {
    client = createGitHubClient(context.env as GitHubEnv);
    clients.set(context.env, client);
  }
  const github = client;
  function authorize(repo: string, write: boolean): void {
    validateRepo(repo);
    if (
      !context.principal.sessions.includes(context.sessionId) ||
      !context.principal.resources.includes(`github:${repo}:${write ? "write" : "read"}`)
    )
      throw new Error("github_forbidden");
    github.auth.installation(repo);
  }
  return defineExtension({
    name: "github",
    tools: [
      defineTool({
        name: "github_read_file",
        description:
          "Read one UTF-8 file in an explicitly allowed GitHub repository. No arbitrary API access.",
        replay: "safe",
        parameters: Type.Object(
          { repo: repoSchema, path: string(500), ref: refSchema },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          authorize(args.repo, false);
          ref(args.ref);
          const data = await github.request(
            args.repo,
            false,
            "GET",
            `contents/${path(args.path)}?ref=${encodeURIComponent(args.ref)}`,
          );
          if (
            data.type !== "file" ||
            data.encoding !== "base64" ||
            typeof data.content !== "string" ||
            data.content.length > 400_000 ||
            typeof data.sha !== "string"
          )
            throw new Error("github_unsupported_file");
          sha(data.sha);
          try {
            const bytes = Uint8Array.from(atob(data.content.replace(/\n/g, "")), (c) =>
              c.charCodeAt(0),
            );
            return output({
              sha: data.sha,
              content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            });
          } catch {
            throw new Error("github_unsupported_file");
          }
        },
      }),
      defineTool({
        name: "github_create_branch",
        description:
          "Create a branch at an exact commit SHA. Side effect; not automatically replayed. Existing branches fail without changing them.",
        replay: "unsafe",
        parameters: Type.Object(
          { repo: repoSchema, branch: refSchema, sha: shaSchema },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          authorize(args.repo, true);
          ref(args.branch);
          sha(args.sha);
          const data = await github.request(args.repo, true, "POST", "git/refs", {
            ref: `refs/heads/${args.branch}`,
            sha: args.sha,
          });
          if (data.ref !== `refs/heads/${args.branch}` || data.object?.sha !== args.sha)
            throw new Error("github_invalid_response");
          return output({ ref: `refs/heads/${args.branch}`, sha: args.sha });
        },
      }),
      defineTool({
        name: "github_write_file",
        description:
          "Write a UTF-8 file on a branch with expected SHA (null only for new files). Side effect; stale writes fail. Never automatically replay.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            repo: repoSchema,
            branch: refSchema,
            path: string(500),
            content: Type.String({ maxLength: 100_000 }),
            expectedSha: Type.Union([shaSchema, Type.Null()]),
            message: string(500),
          },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          authorize(args.repo, true);
          ref(args.branch);
          text(args.message, 500);
          if (args.expectedSha !== null) sha(args.expectedSha);
          if (typeof args.content !== "string" || args.content.length > 100_000)
            throw new Error("invalid_content");
          const bytes = new TextEncoder().encode(args.content);
          // Avoid spreading large files onto the JS stack.
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          const data = await github.request(args.repo, true, "PUT", `contents/${path(args.path)}`, {
            branch: args.branch,
            message: args.message,
            content: btoa(binary),
            ...(args.expectedSha === null ? {} : { sha: args.expectedSha }),
          });
          if (typeof data.content?.sha !== "string" || typeof data.commit?.sha !== "string")
            throw new Error("github_invalid_response");
          sha(data.content.sha);
          sha(data.commit.sha);
          return output({ sha: data.content.sha, commit: data.commit.sha });
        },
      }),
      defineTool({
        name: "github_open_pull_request",
        description:
          "Open a pull request, never merge or deploy. Side effect; not replay safe. After an ambiguous failure inspect GitHub before retrying.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            repo: repoSchema,
            head: refSchema,
            base: refSchema,
            title: string(256),
            body: Type.String({ maxLength: 20_000 }),
          },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          authorize(args.repo, true);
          ref(args.head);
          ref(args.base);
          text(args.title, 256);
          if (args.head === args.base || typeof args.body !== "string" || args.body.length > 20_000)
            throw new Error("invalid_pull_request");
          const data = await github.request(args.repo, true, "POST", "pulls", {
            head: args.head,
            base: args.base,
            title: args.title,
            body: args.body,
          });
          if (!Number.isSafeInteger(data.number) || data.number <= 0)
            throw new Error("github_invalid_response");
          return output({ number: data.number });
        },
      }),
    ],
  });
}
