import { Hono } from "hono";
import { create, deliver } from "./index";
import type {
  AdapterAppEnv,
  AdapterDependencies,
  DeliveryContext,
  GitHubAuth,
} from "@remote-agent/adapter-contract";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Response as WorkerResponse } from "miniflare";

const secret = "local-github-webhook-secret";
const session = "github_6ccfd6e21a400d6c0758ad87e19582704ce570ebbc6a7a83a4057faaba0cf043";
async function options(
  state: string,
  outboundService: (request: Request) => Promise<WorkerResponse>,
) {
  const { build } = await import("vite");
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const buildResult = await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["workerd", "worker", "browser"] },
    build: {
      write: false,
      target: "es2022",
      minify: false,
      lib: { entry: resolve("src/index.ts"), formats: ["es"] },
      rollupOptions: { external: /^(cloudflare:|node:)/, output: { inlineDynamicImports: true } },
    },
  });
  const output = Array.isArray(buildResult) ? buildResult[0] : buildResult;
  assert("output" in output);
  const chunk = output.output.find((item) => item.type === "chunk" && item.isEntry);
  assert(chunk?.type === "chunk");
  const modules = [
    { type: "ESModule" as const, path: resolve("dist/github-test.js"), contents: chunk.code },
  ];
  const common = {
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    modules,
  };
  const bindings = {
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_BOT_LOGIN: "helper[bot]",
    GITHUB_ACTORS: '["alice"]',
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: privateKey,
    GITHUB_REPOSITORIES: '{"team/project":456,"team/second":456}',
    MODEL_PROVIDER: "anthropic",
    MODEL_ID: "claude-sonnet-4-5",
    ANTHROPIC_API_KEY: "local-fake-key",
    TEAM_AUTH: JSON.stringify([
      {
        id: "member",
        token: "local-member-token-at-least-32-bytes",
        sessions: [session],
        resources: [],
      },
      {
        id: "outsider",
        token: "local-outsider-token-at-least-32-bytes",
        sessions: ["other"],
        resources: [],
      },
    ]),
  };
  return {
    durableObjectsPersist: state,
    workers: [
      {
        ...common,
        name: "core",
        outboundService,
        bindings,
        durableObjects: {
          SESSIONS: { className: "SessionAgent", useSQLite: true },
          ADAPTER_JOBS: { className: "AdapterJobs", useSQLite: true },
        },
      },
      { ...common, name: "missing-outbox", bindings },
      { ...common, name: "unconfigured" },
    ],
  };
}
function payload(overrides: Record<string, unknown> = {}, event = "issue_comment") {
  return {
    action: "created",
    repository: { full_name: "team/project" },
    installation: { id: 456 },
    sender: { id: 42, login: "alice", type: "User" },
    ...(event === "issue_comment" ? { issue: { number: 7 } } : { pull_request: { number: 7 } }),
    comment: { id: 90, body: "@helper[bot] Hello", user: { id: 42, login: "alice", type: "User" } },
    ...overrides,
  };
}
function signed(body: unknown, delivery = "delivery-1", event = "issue_comment") {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return {
    method: "POST",
    body: raw,
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      "x-github-delivery": delivery,
      "x-github-event": event,
    },
  };
}
function answer(text = "Thread answer") {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_github",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise<void>((done) => setImmediate(done));
  }
  assert.fail("GitHub job did not reach expected durable state");
}

test(
  "GitHub raw signatures, policy, event shapes and mention boundaries reject before execution",
  { timeout: 15000 },
  async () => {
    // GitHubAuth is the external App capability; no persistence belongs on rejection paths.
    const github: GitHubAuth = {
      installation(repo) {
        if (repo !== "team/project") throw new Error("repository_forbidden");
        return 456;
      },
      token: async () => assert.fail("Rejected webhook requested a token"),
      invalidate: () => assert.fail("Rejected webhook invalidated a token"),
    };
    const dependencies: AdapterDependencies = {
      github: () => github,
      authenticate: async () => assert.fail("Webhook unexpectedly required team auth"),
      execute: async () => assert.fail("Rejected webhook reached durable execution"),
      submit: async () => assert.fail("Webhook bypassed durable execution"),
      status: async () => assert.fail("Webhook requested job status"),
    };
    const app = new Hono<AdapterAppEnv>().route("/adapters/github", create(dependencies));
    const env = {
      GITHUB_WEBHOOK_SECRET: secret,
      GITHUB_BOT_LOGIN: "helper[bot]",
      GITHUB_ACTORS: '["alice"]',
    };
    const core = { fetch: (url: string, init?: RequestInit) => app.request(url, init, env) };
    const send = (body: unknown, delivery?: string, event?: string) =>
      core.fetch("http://localhost/adapters/github", signed(body, delivery, event));
    assert.equal(
      (await app.request("http://localhost/adapters/github", signed(payload()), {})).status,
      503,
    );
    assert.equal(
      (await core.fetch("http://localhost/adapters/github", { method: "POST", body: "{}" })).status,
      401,
    );
    const tampered = signed(payload());
    tampered.body += " ";
    assert.equal(
      (await core.fetch("http://localhost/adapters/github", tampered)).status,
      401,
      "Signature covers raw bytes",
    );
    assert.equal((await send("{")).status, 400);
    for (const invalid of ["null", "[]", "42", "{}", payload({ action: 1 })])
      assert.equal((await send(invalid)).status, 400);
    assert.equal((await send("x".repeat(32769))).status, 413);
    assert.equal((await send(payload({ repository: { full_name: "team/other" } }))).status, 403);
    assert.equal((await send(payload({ installation: { id: 457 } }))).status, 403);
    assert.equal(
      (
        await send(
          payload({
            sender: { id: 43, login: "mallory", type: "User" },
            comment: {
              id: 90,
              body: "@helper[bot] Hi",
              user: { id: 43, login: "mallory", type: "User" },
            },
          }),
        )
      ).status,
      403,
    );
    assert.equal(
      (await send(payload({ sender: { id: 43, login: "alice", type: "User" } }))).status,
      400,
      "Sender must match the comment author, not just its allowed login",
    );
    for (const body of [
      payload({ issue: { number: "7" } }),
      payload({ comment: { ...payload().comment, id: -1 } }),
      payload({ comment: { ...payload().comment, body: "x".repeat(16001) } }),
      payload({ comment: { ...payload().comment, in_reply_to_id: "90" } }),
    ])
      assert.equal((await send(body)).status, 400);
    assert.equal((await send(payload(), "../bad")).status, 400);
    for (const [login, type] of [
      ["helper[bot]", "User"],
      ["another[bot]", "Bot"],
    ]) {
      const user = { id: 42, login, type };
      assert.deepEqual(
        await (
          await send(payload({ sender: user, comment: { ...payload().comment, user } }))
        ).json(),
        { ignored: true },
      );
    }
    for (const body of [
      "ordinary text",
      "@helper[bot]-other",
      "email@helper[bot]",
      "@@helper[bot]",
      "@helper[bot] ",
    ]) {
      assert.deepEqual(
        await (await send(payload({ comment: { ...payload().comment, body } }))).json(),
        { ignored: true },
      );
    }
    assert.deepEqual(await (await send(payload({ action: "edited" }))).json(), { ignored: true });
    assert.deepEqual(await (await send(payload(), "irrelevant", "push")).json(), { ignored: true });
  },
);

test(
  "GitHub durable acceptance dedupes; retries survive restart; issue and PR replies share history and failures stay visible",
  { timeout: 45000 },
  async () => {
    const { Miniflare, Response: WorkerResponse } = await import("miniflare");
    const state = await mkdtemp(join(tmpdir(), "github-outbox-"));
    const replies: { at: number; path: string; body: any }[] = [];
    const inputs: any[] = [];
    let rejectReply = false;
    let replyText = "Thread answer";
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const config = await options(state, async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "api.anthropic.com") {
        inputs.push(await request.json());
        await gate;
        return new WorkerResponse(answer(replyText), {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      assert.equal(url.hostname, "api.github.com");
      if (url.pathname === "/app/installations/456/access_tokens") {
        const scope = (await request.json()) as { repositories: string[]; permissions: unknown };
        assert(
          ["project", "second"].includes(scope.repositories[0]) && scope.repositories.length === 1,
        );
        assert.deepEqual(
          scope.permissions,
          { issues: "write", pull_requests: "write" },
          "Replies use the shared App auth reply scope, never contents-write",
        );
        return WorkerResponse.json({
          token: "local-installation-token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), "Bearer local-installation-token");
      replies.push({ at: Date.now(), path: url.pathname, body: await request.json() });
      if (rejectReply) return new WorkerResponse("private vendor detail", { status: 401 });
      if (replies.length === 1)
        return new WorkerResponse("", { status: 429, headers: { "Retry-After": "2" } });
      return WorkerResponse.json({ id: 999 }, { status: 201 });
    });
    let runtime = new Miniflare(config);
    let core = await runtime.getWorker("core");
    let base = await runtime.ready;
    const send = (body: unknown, operation = "delivery-1", event = "issue_comment") =>
      core.fetch("http://localhost/adapters/github", signed(body, operation, event));
    const status = async (operation = "delivery-1") => {
      const response = await fetch(
        new URL(`/adapters/github/jobs/team/project/7/${operation}`, base),
        { headers: { Authorization: "Bearer local-member-token-at-least-32-bytes" } },
      );
      assert.equal(response.status, 200);
      return response.json() as Promise<{
        state: string;
        attempts: number;
        due: number;
        failure: { code: string; attempts: number } | null;
      }>;
    };
    try {
      const missing = await runtime.getWorker("missing-outbox");
      assert.equal(
        (await missing.fetch("http://localhost/adapters/github", signed(payload()))).status,
        503,
        "Never ACK a mention without a durable inbox",
      );
      const statusUrl = "http://localhost/adapters/github/jobs/team/project/7/missing";
      assert.equal((await core.fetch(statusUrl)).status, 401);
      assert.equal(
        (
          await core.fetch(statusUrl, {
            headers: { Authorization: "Bearer local-outsider-token-at-least-32-bytes" },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await core.fetch(statusUrl, {
            headers: { Authorization: "Bearer local-member-token-at-least-32-bytes" },
          })
        ).status,
        404,
      );
      const accepted = await send(payload());
      assert.equal(accepted.status, 202);
      assert.deepEqual(await accepted.json(), { accepted: true, operationId: "delivery-1" });
      assert(
        ["queued", "waiting"].includes((await status()).state),
        "ACK follows persistent acceptance, not model completion",
      );
      await until(
        async () => inputs.length,
        (n) => n === 1,
      );
      assert.equal(replies.length, 0);
      for (const duplicate of await Promise.all([send(payload()), send(payload())])) {
        assert.equal(duplicate.status, 202);
        assert.deepEqual(await duplicate.json(), { accepted: false, operationId: "delivery-1" });
      }
      assert.equal(
        (await send(payload({ comment: { ...payload().comment, body: "@helper[bot] Changed" } })))
          .status,
        409,
      );
      assert.equal(
        inputs[0].system,
        undefined,
        "No origin or credentials injected into model context",
      );
      assert.deepEqual(
        inputs[0].messages[0].content.map((block: { text?: string }) => block.text),
        ["Hello"],
      );
      release();
      await until(
        () => status(),
        (job) =>
          job.state === "delivering" && job.attempts === 1 && job.due >= replies[0].at + 2000,
      );
      await runtime.dispose();
      runtime = new Miniflare(config);
      core = await runtime.getWorker("core");
      base = await runtime.ready;
      assert.deepEqual(await (await send(payload())).json(), {
        accepted: false,
        operationId: "delivery-1",
      });
      const delivered = await until(
        () => status(),
        (job) => job.state === "delivered",
      );
      assert.equal(delivered.attempts, 2);
      assert.equal(replies.length, 2);
      assert(
        replies[1].at - replies[0].at >= 2000,
        "Persisted GitHub Retry-After must survive restart",
      );
      assert.deepEqual(replies[1].body, { body: "Thread answer" });
      assert.equal(replies[1].path, "/repos/team/project/issues/7/comments");
      assert.equal(inputs.length, 1, "Reply retry must not rerun the model");

      replyText = "Review answer";
      assert.equal(
        (
          await send(
            payload(
              {
                comment: {
                  ...payload().comment,
                  id: 91,
                  in_reply_to_id: 90,
                  body: "(@HELPER[bot]) Continue",
                },
              },
              "pull_request_review_comment",
            ),
            "review-2",
            "pull_request_review_comment",
          )
        ).status,
        202,
      );
      await until(
        () => status("review-2"),
        (job) => job.state === "delivered",
      );
      assert.equal(
        inputs[1].messages.length,
        3,
        "Issue and PR review mentions in one repository/number reuse history",
      );
      assert.equal(replies[2].path, "/repos/team/project/pulls/7/comments");
      assert.equal(
        replies[2].body.in_reply_to,
        90,
        "Review replies target the top-level review thread",
      );
      assert.equal(replies[2].body.body, "Review answer");

      replyText = "Isolated answer";
      for (const [repo, number, operation] of [
        ["team/project", 8, "issue-8"],
        ["team/second", 7, "second-repo"],
      ] as const) {
        const before = replies.length;
        assert.equal(
          (await send(payload({ repository: { full_name: repo }, issue: { number } }), operation))
            .status,
          202,
        );
        await until(
          async () => replies.length,
          (n) => n === before + 1,
        );
        assert.equal(
          inputs.at(-1).messages.length,
          1,
          "Different repository or issue must have an isolated conversation",
        );
        assert.equal(replies.at(-1)?.path, `/repos/${repo}/issues/${number}/comments`);
      }
      const beforeFailure = replies.length;
      rejectReply = true;
      replyText = "Another answer";
      assert.equal((await send(payload(), "failed-3")).status, 202);
      const failed = await until(
        () => status("failed-3"),
        (job) => job.state === "failed",
      );
      assert.deepEqual(failed.failure, { code: "github_unauthorized", attempts: 1 });
      assert.equal(
        replies.length,
        beforeFailure + 1,
        "Permanent authorization failure must not retry",
      );
      await runtime.dispose();
      runtime = new Miniflare(config);
      core = await runtime.getWorker("core");
      base = await runtime.ready;
      assert.deepEqual(
        await status("failed-3"),
        failed,
        "Failure is durable and visible to authorized status readers",
      );
      assert.deepEqual(await (await send(payload(), "failed-3")).json(), {
        accepted: false,
        operationId: "failed-3",
      });
    } finally {
      release();
      await runtime.dispose();
      await rm(state, { recursive: true, force: true });
    }
  },
);

test("GitHub delivery bounds UTF-8 replies and classifies rate limits, vendor errors and App auth failures", async (t) => {
  const now = 1800000000000;
  t.mock.method(Date, "now", () => now);
  let authError: unknown;
  let invalidations = 0;
  const github: GitHubAuth = {
    installation: () => 456,
    token: async () => {
      if (authError) throw authError;
      return "boundary-token";
    },
    invalidate: () => {
      invalidations++;
    },
  };
  const context: DeliveryContext = {
    env: {},
    github,
    signal: new AbortController().signal,
    job: {
      adapter: "github",
      input: { sessionId: session, operationId: "reply", input: "Hello" },
      principal: { id: session, sessions: [session], resources: [] },
      reply: { repo: "team/project", number: 7 },
    },
    result: { sessionId: session, operationId: "reply", status: "done", text: "Answer" },
  };
  let response = new Response(null, { status: 201 });
  let transportFailure = false;
  let sends = 0;
  let expectedBody = "😀".repeat(15000) + "\n\n[Response truncated; see the session.]";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    sends++;
    assert.equal(url, "https://api.github.com/repos/team/project/issues/7/comments");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer boundary-token");
    assert.deepEqual(
      JSON.parse(String(init.body)),
      { body: expectedBody },
      "Reply content preserves complete UTF-8 characters and includes a visible notice when truncated",
    );
    if (transportFailure) throw new TypeError("network unavailable");
    return response;
  });
  context.result.text = "😀".repeat(16000);
  assert.deepEqual(await deliver(context), { status: "delivered" });
  context.result.text = "Answer";
  expectedBody = "Answer";
  for (const [status, headers, delay] of [
    [429, { "retry-after": "2" }, 2000],
    [403, { "retry-after": "3" }, 3000],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 45) }, 45000],
    [429, { "retry-after": new Date(now + 60000).toUTCString() }, 60000],
    [429, { "retry-after": "99999" }, 3600000],
    [503, {}, undefined],
  ] as const) {
    response = new Response(null, { status, headers: new Headers(headers) });
    assert.deepEqual(
      await deliver(context),
      { status: "retry", code: "github_rate_or_server_error", retryAfterMs: delay },
      `HTTP ${status} must preserve its retry delay`,
    );
  }
  for (const status of [403, 404, 422]) {
    response = new Response(null, { status });
    assert.deepEqual(await deliver(context), { status: "failed", code: "github_reply_rejected" });
  }
  response = new Response(null, { status: 401 });
  assert.deepEqual(await deliver(context), { status: "failed", code: "github_unauthorized" });
  assert.equal(invalidations, 1, "Unauthorized installation token is evicted");
  transportFailure = true;
  assert.deepEqual(await deliver(context), { status: "retry", code: "github_transport_failed" });
  const sendsBeforeAuthFailure = sends;
  authError = Object.assign(new Error("github_http_403"), { status: 403, retryAfter: "30" });
  assert.deepEqual(
    await deliver(context),
    { status: "retry", code: "github_auth_unavailable", retryAfterMs: 30000 },
    "Secondary rate limits during App token acquisition preserve the retry delay, unlike ordinary auth 403s",
  );
  for (const error of [
    Object.assign(new Error("limited"), { status: 429, retryAfter: "4" }),
    Object.assign(new Error("upstream"), { status: 502 }),
    new Error("github_transport_failed"),
  ]) {
    authError = error;
    const result = await deliver(context);
    assert.deepEqual(result, {
      status: "retry",
      code: "github_auth_unavailable",
      retryAfterMs: error.message === "limited" ? 4000 : undefined,
    });
  }
  for (const status of [401, 403, 404]) {
    authError = Object.assign(new Error("denied"), { status });
    assert.deepEqual(await deliver(context), { status: "failed", code: "github_auth_failed" });
  }
  assert.equal(
    sends,
    sendsBeforeAuthFailure,
    "App auth failures never send unauthenticated comments",
  );
});
