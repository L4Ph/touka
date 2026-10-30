import type nodeAssert from "node:assert/strict";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolContext } from "../../tools";
import { githubConnector } from "@remote-agent/connector-github";

const string = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const repoSchema = string(140);
const refSchema = string(200);
const shaSchema = Type.String({ pattern: "^[0-9a-f]{40}$" });
/** The issue or pull request this conversation was started from, if any. */
function currentThread(resources: readonly string[]): { repo: string; number: number } | null {
  for (const resource of resources) {
    const match = /^github-thread:([^#]+)#(\d+)$/.exec(resource);
    if (match) return { repo: match[1], number: Number(match[2]) };
  }
  return null;
}
function output(value: unknown) {
  return { output: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function create(context: ToolContext) {
  const github = githubConnector(context.env);
  // Explicit arguments win; otherwise fall back to the conversation's own issue or pull request.
  const thread = (args: { repo?: string; number?: number }, resources: readonly string[]) => {
    const current = currentThread(resources);
    if (args.repo !== undefined && args.number === undefined)
      throw new Error("github_number_required");
    const repo = args.repo ?? current?.repo;
    const number = args.number ?? current?.number;
    if (repo === undefined || number === undefined) throw new Error("github_no_thread");
    return { repo, number };
  };
  const repoOf = (repo: string | undefined, resources: readonly string[]) => {
    const found = repo ?? currentThread(resources)?.repo;
    if (found === undefined) throw new Error("github_no_thread");
    return found;
  };
  const allowed = () => {
    if (!context.principal.sessions.includes(context.sessionId))
      throw new Error("github_forbidden");
    return context.principal.resources;
  };
  const optionalTarget = {
    repo: Type.Optional(repoSchema),
    number: Type.Optional(Type.Integer({ minimum: 1 })),
  };
  const side = Type.Union([Type.Literal("LEFT"), Type.Literal("RIGHT")]);
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
        execute: async (args) => output(await github.readFile(args, allowed())),
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
        execute: async (args) => output(await github.createBranch(args, allowed())),
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
        execute: async (args) => output(await github.writeFile(args, allowed())),
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
        execute: async (args) => output(await github.openPullRequest(args, allowed())),
      }),
      defineTool({
        name: "github_get_issue",
        description:
          "Read an issue or pull request conversation: body, labels and the latest comments. Omit repo and number to read the issue or pull request this conversation started from. For pull request code and reviews use github_get_pull_request.",
        replay: "safe",
        parameters: Type.Object(
          { repo: Type.Optional(repoSchema), number: Type.Optional(Type.Integer({ minimum: 1 })) },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(await github.getIssue(thread(args, resources), resources));
        },
      }),
      defineTool({
        name: "github_get_pull_request",
        description:
          "Read a pull request: metadata, changed files with patches (bounded) and the latest review comments. Omit repo and number to read the pull request this conversation started from.",
        replay: "safe",
        parameters: Type.Object(
          { repo: Type.Optional(repoSchema), number: Type.Optional(Type.Integer({ minimum: 1 })) },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(await github.getPullRequest(thread(args, resources), resources));
        },
      }),
      defineTool({
        name: "github_create_issue",
        description:
          "Open an issue. Side effect; not replay safe. After an ambiguous failure inspect GitHub before retrying.",
        replay: "unsafe",
        parameters: Type.Object(
          { repo: repoSchema, title: string(256), body: Type.String({ maxLength: 20_000 }) },
          { additionalProperties: false },
        ),
        execute: async (args) => output(await github.createIssue(args, allowed())),
      }),
      defineTool({
        name: "github_comment",
        description:
          "Comment on an issue or pull request conversation. Side effect; not replay safe, so a retry can post twice.",
        replay: "unsafe",
        parameters: Type.Object(
          { repo: repoSchema, number: Type.Integer({ minimum: 1 }), body: string(20_000) },
          { additionalProperties: false },
        ),
        execute: async (args) => output(await github.comment(args, allowed())),
      }),
      defineTool({
        name: "github_review_pull_request",
        description:
          "Submit one review on a pull request: COMMENT, APPROVE or REQUEST_CHANGES, with optional inline comments on lines of the diff (path, line, side RIGHT for new code, LEFT for removed code; startLine for a range) pinned to commitId (the head sha from github_get_pull_request). Omit repo and number for the pull request this conversation started from. Never merges. Side effect; not replay safe.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            ...optionalTarget,
            event: Type.Union([
              Type.Literal("COMMENT"),
              Type.Literal("APPROVE"),
              Type.Literal("REQUEST_CHANGES"),
            ]),
            body: Type.String({ maxLength: 20_000 }),
            commitId: Type.Optional(shaSchema),
            comments: Type.Optional(
              Type.Array(
                Type.Object(
                  {
                    path: string(500),
                    line: Type.Integer({ minimum: 1 }),
                    side: Type.Optional(side),
                    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
                    startSide: Type.Optional(side),
                    body: string(4_000),
                  },
                  { additionalProperties: false },
                ),
                { maxItems: 50 },
              ),
            ),
          },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.reviewPullRequest({ ...args, ...thread(args, resources) }, resources),
          );
        },
      }),
      defineTool({
        name: "github_reply_review_comment",
        description:
          "Answer in an existing pull request review thread (commentId is the id of a comment in it, from github_get_pull_request). Side effect; not replay safe.",
        replay: "unsafe",
        parameters: Type.Object(
          { ...optionalTarget, commentId: Type.Integer({ minimum: 1 }), body: string(20_000) },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.replyReviewComment(
              { ...thread(args, resources), commentId: args.commentId, body: args.body },
              resources,
            ),
          );
        },
      }),
      defineTool({
        name: "github_list_files",
        description:
          "List the entries of a directory in a repository (empty path for the root), to find a file before reading it with github_read_file.",
        replay: "safe",
        parameters: Type.Object(
          {
            repo: Type.Optional(repoSchema),
            path: Type.Optional(Type.String({ maxLength: 500 })),
            ref: Type.Optional(refSchema),
          },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.listFiles({ ...args, repo: repoOf(args.repo, resources) }, resources),
          );
        },
      }),
      defineTool({
        name: "github_search_code",
        description:
          "Search code in one repository (GitHub code search syntax; results are file paths, read them with github_read_file). The index can lag behind recent pushes.",
        replay: "safe",
        parameters: Type.Object(
          { repo: Type.Optional(repoSchema), query: string(200) },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.searchCode(
              { repo: repoOf(args.repo, resources), query: args.query },
              resources,
            ),
          );
        },
      }),
      defineTool({
        name: "github_get_checks",
        description:
          "CI state of a ref (use a pull request's headSha): check runs with their conclusion and a summary, and commit statuses. A failing check run's id is its job id for github_get_job_log.",
        replay: "safe",
        parameters: Type.Object(
          { repo: Type.Optional(repoSchema), ref: refSchema },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.getChecks(
              { repo: repoOf(args.repo, resources), ref: args.ref },
              resources,
            ),
          );
        },
      }),
      defineTool({
        name: "github_get_job_log",
        description:
          "The last 12,000 characters of a GitHub Actions job log (the id of a failing check run from github_get_checks).",
        replay: "safe",
        parameters: Type.Object(
          { repo: Type.Optional(repoSchema), jobId: Type.Integer({ minimum: 1 }) },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.getJobLog(
              { repo: repoOf(args.repo, resources), jobId: args.jobId },
              resources,
            ),
          );
        },
      }),
      defineTool({
        name: "github_commit_files",
        description:
          "Commit several files to an existing branch in one commit: each entry is {path, content} to write or {path, delete: true} to remove. The branch only moves if nobody pushed meanwhile. Files are written as regular non-executable files; paths under .github/workflows/ need a separate workflow grant that conversations do not get by default. Side effect; not replay safe.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            repo: Type.Optional(repoSchema),
            branch: refSchema,
            message: string(500),
            files: Type.Array(
              Type.Object(
                {
                  path: string(500),
                  content: Type.Optional(Type.String({ maxLength: 100_000 })),
                  delete: Type.Optional(Type.Boolean()),
                },
                { additionalProperties: false },
              ),
              { minItems: 1, maxItems: 50 },
            ),
          },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.commitFiles({ ...args, repo: repoOf(args.repo, resources) }, resources),
          );
        },
      }),
      defineTool({
        name: "github_update_issue",
        description:
          "Edit an issue (or the issue side of a pull request): title, body, state (open or closed, with stateReason completed, not_planned or reopened), labels (replaces all) and assignees (replaces all). Omit repo and number for this conversation's issue. Side effect; not replay safe.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            ...optionalTarget,
            title: Type.Optional(string(256)),
            body: Type.Optional(Type.String({ maxLength: 20_000 })),
            state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
            stateReason: Type.Optional(
              Type.Union([
                Type.Literal("completed"),
                Type.Literal("not_planned"),
                Type.Literal("reopened"),
              ]),
            ),
            labels: Type.Optional(Type.Array(string(50), { maxItems: 20 })),
            assignees: Type.Optional(Type.Array(string(40), { maxItems: 10 })),
          },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.updateIssue({ ...args, ...thread(args, resources) }, resources),
          );
        },
      }),
      defineTool({
        name: "github_add_labels",
        description:
          "Add labels to an issue or pull request, keeping the ones already there. Omit repo and number for this conversation's. Side effect.",
        replay: "unsafe",
        parameters: Type.Object(
          { ...optionalTarget, labels: Type.Array(string(50), { minItems: 1, maxItems: 20 }) },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.addLabels({ ...thread(args, resources), labels: args.labels }, resources),
          );
        },
      }),
      defineTool({
        name: "github_update_pull_request",
        description:
          "Edit a pull request: title, body, base branch, or state (open or closed). It cannot merge, and it cannot change the draft state. Omit repo and number for this conversation's. Side effect.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            ...optionalTarget,
            title: Type.Optional(string(256)),
            body: Type.Optional(Type.String({ maxLength: 20_000 })),
            base: Type.Optional(refSchema),
            state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
          },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.updatePullRequest({ ...args, ...thread(args, resources) }, resources),
          );
        },
      }),
      defineTool({
        name: "github_request_reviewers",
        description:
          "Ask people (reviewers) or teams (teamReviewers) to review a pull request. Omit repo and number for this conversation's. Side effect.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            ...optionalTarget,
            reviewers: Type.Optional(Type.Array(string(40), { maxItems: 15 })),
            teamReviewers: Type.Optional(Type.Array(string(40), { maxItems: 15 })),
          },
          { additionalProperties: false },
        ),
        execute: async (args) => {
          const resources = allowed();
          return output(
            await github.requestReviewers({ ...args, ...thread(args, resources) }, resources),
          );
        },
      }),
    ],
  });
}

if (import.meta.vitest) {
  const { vi, test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { generateKeyPairSync } = await import("node:crypto");
  const { deliver } = await import("@remote-agent/trigger-github");

  test("agent Tools and Trigger replies share the GitHub Connector, but reply authority cannot write repository contents", async () => {
    const env = Object.assign(Object.create(null), {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      GITHUB_REPOSITORIES: '{"team/project":42}',
    });
    const scopes: unknown[] = [];
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      assert.ok(typeof url === "string" && init);
      const path = new URL(url).pathname;
      if (path.endsWith("/access_tokens")) {
        scopes.push(JSON.parse(String(init.body)).permissions);
        return Response.json({
          token: `token-${scopes.length}`,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      paths.push(path);
      if (path.endsWith("/issues/7/comments")) {
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer token-1");
        assert.deepEqual(JSON.parse(String(init.body)), { body: "Answer" });
        return new Response(null, { status: 201 });
      }
      assert.equal(path, "/repos/team/project/contents/hello.txt");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer token-2");
      return Response.json({
        type: "file",
        encoding: "base64",
        content: btoa("Hello"),
        sha: "a".repeat(40),
      });
    });
    assert.deepEqual(
      await deliver({
        env,
        job: {
          trigger: "github",
          input: { sessionId: "thread", operationId: "event", input: "task" },
          principal: { id: "actor", sessions: ["thread"], resources: [] },
          reply: { repo: "team/project", number: 7 },
        },
        result: { sessionId: "thread", operationId: "event", status: "done", text: "Answer" },
        signal: new AbortController().signal,
      }),
      { status: "delivered" },
    );
    const context = {
      env,
      sessionId: "conversation",
      principal: {
        id: "viewer",
        sessions: ["conversation"],
        resources: ["github:team/project:read"],
      },
    };
    const tools = create(context).tools!;
    // The model-facing surface: every tool and whether replaying it is safe. Order is not a contract.
    assert.deepEqual(tools.map((tool) => `${tool.name}:${tool.replay}`).sort(), [
      "github_add_labels:unsafe",
      "github_comment:unsafe",
      "github_commit_files:unsafe",
      "github_create_branch:unsafe",
      "github_create_issue:unsafe",
      "github_get_checks:safe",
      "github_get_issue:safe",
      "github_get_job_log:safe",
      "github_get_pull_request:safe",
      "github_list_files:safe",
      "github_open_pull_request:unsafe",
      "github_read_file:safe",
      "github_reply_review_comment:unsafe",
      "github_request_reviewers:unsafe",
      "github_review_pull_request:unsafe",
      "github_search_code:safe",
      "github_update_issue:unsafe",
      "github_update_pull_request:unsafe",
      "github_write_file:unsafe",
    ]);
    const read = tools.find((tool) => tool.name === "github_read_file")!;
    const args = { repo: "team/project", path: "hello.txt", ref: "main" };
    assert.deepEqual(JSON.parse((await Reflect.apply(read.execute, read, [args])).output[0].text), {
      sha: "a".repeat(40),
      content: "Hello",
    });
    const write = tools.find((tool) => tool.name === "github_create_branch")!;
    await assert.rejects(
      Reflect.apply(write.execute, write, [
        { repo: "team/project", branch: "change", sha: "a".repeat(40) },
      ]),
      /github_forbidden/,
    );
    const unbound = create({ ...context, principal: { ...context.principal, sessions: [] } })
      .tools![0];
    await assert.rejects(Reflect.apply(unbound.execute, unbound, [args]), /github_forbidden/);
    assert.deepEqual(scopes, [
      { issues: "write", pull_requests: "write" },
      { contents: "read", issues: "read", pull_requests: "read" },
    ]);
    assert.deepEqual(paths, [
      "/repos/team/project/issues/7/comments",
      "/repos/team/project/contents/hello.txt",
    ]);
  });

  test("reading tools default to the conversation's own issue or pull request, and need either that or explicit arguments", async () => {
    const env = Object.assign(Object.create(null), {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      GITHUB_REPOSITORIES: '{"team/*":42}',
    });
    const paths: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      assert.ok(typeof url === "string");
      const path = new URL(url).pathname;
      if (path.endsWith("/access_tokens"))
        return Response.json({
          token: "token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      paths.push(path);
      return Response.json(
        path.endsWith("/comments") ? [] : { number: 12, title: "Thread", comments: 0 },
      );
    });
    const tools = (resources: string[]) =>
      create({
        env,
        sessionId: "conversation",
        principal: { id: "viewer", sessions: ["conversation"], resources },
      }).tools!;
    const read = (resources: string[], args: object) => {
      const tool = tools(resources).find((tool) => tool.name === "github_get_issue")!;
      return Reflect.apply(tool.execute, tool, [args]);
    };
    const resources = ["github:team/project:read", "github-thread:team/project#12"];
    await read(resources, {});
    await read(resources, { number: 3 });
    assert.deepEqual(paths, [
      "/repos/team/project/issues/12",
      "/repos/team/project/issues/12/comments",
      "/repos/team/project/issues/3",
      "/repos/team/project/issues/3/comments",
    ]);
    await assert.rejects(read(["github:team/project:read"], {}), /github_no_thread/);
    await assert.rejects(read(resources, { repo: "team/project" }), /github_number_required/);
  });

  test("writing tools default to the conversation's pull request, and every tool needs its grant", async () => {
    const env = Object.assign(Object.create(null), {
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      GITHUB_REPOSITORIES: '{"team/*":42}',
    });
    const calls: { path: string; body: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/access_tokens"))
        return Response.json({
          token: "t",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return Response.json(
        path.endsWith("/labels")
          ? []
          : path.includes("contents")
            ? []
            : { id: 5, number: 12, state: "open" },
      );
    });
    const tools = (resources: string[]) =>
      create({
        env,
        sessionId: "conversation",
        principal: { id: "viewer", sessions: ["conversation"], resources },
      }).tools!;
    const run = (resources: string[], name: string, args: object) => {
      const tool = tools(resources).find((tool) => tool.name === name)!;
      return Reflect.apply(tool.execute, tool, [args]);
    };
    const both = [
      "github:team/project:read",
      "github:team/project:write",
      "github-thread:team/project#12",
    ];
    await run(both, "github_review_pull_request", { event: "APPROVE", body: "" });
    await run(both, "github_add_labels", { labels: ["bug"] });
    await run(both, "github_request_reviewers", { reviewers: ["bob"] });
    await run(both, "github_list_files", {});
    assert.deepEqual(
      calls.map((call) => call.path),
      [
        "/repos/team/project/pulls/12/reviews",
        "/repos/team/project/issues/12/labels",
        "/repos/team/project/pulls/12/requested_reviewers",
        "/repos/team/project/contents/",
      ],
    );
    // Reading is not writing, and a conversation with no thread must name its target.
    const readOnly = ["github:team/project:read", "github-thread:team/project#12"];
    for (const [name, args] of [
      ["github_review_pull_request", { event: "APPROVE", body: "" }],
      ["github_commit_files", { branch: "b", message: "m", files: [{ path: "a", content: "1" }] }],
      ["github_update_issue", { title: "t" }],
      ["github_add_labels", { labels: ["x"] }],
    ] as const)
      await assert.rejects(run(readOnly, name, args), /github_forbidden/, name);
    await assert.rejects(
      run(["github:team/project:write"], "github_add_labels", { labels: ["x"] }),
      /github_no_thread/,
    );
    await assert.rejects(
      run(["github:team/project:read"], "github_list_files", {}),
      /github_no_thread/,
    );
  });
}
