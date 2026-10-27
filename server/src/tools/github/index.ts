import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolContext } from "../../tools";
import { githubConnector } from "@remote-agent/connector-github";

const string = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const repoSchema = string(140);
const refSchema = string(200);
const shaSchema = Type.String({ pattern: "^[0-9a-f]{40}$" });
function output(value: unknown) {
  return { output: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function create(context: ToolContext) {
  const github = githubConnector(context.env);
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
          if (!context.principal.sessions.includes(context.sessionId))
            throw new Error("github_forbidden");
          return output(await github.readFile(args, context.principal.resources));
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
          if (!context.principal.sessions.includes(context.sessionId))
            throw new Error("github_forbidden");
          return output(await github.createBranch(args, context.principal.resources));
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
          if (!context.principal.sessions.includes(context.sessionId))
            throw new Error("github_forbidden");
          return output(await github.writeFile(args, context.principal.resources));
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
          if (!context.principal.sessions.includes(context.sessionId))
            throw new Error("github_forbidden");
          return output(await github.openPullRequest(args, context.principal.resources));
        },
      }),
    ],
  });
}
