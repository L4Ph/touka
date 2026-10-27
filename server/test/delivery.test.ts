import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { build } from "vite";
import { Miniflare, Response as WorkerResponse } from "miniflare";
import { executionGrant } from "../src/execution";

const token = "delivery-runtime-token-not-secret-00001";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const sessions = ["retry", "permanent", "exhausted", "tools", "denied", "queue"];
const member = { id: "member", token, sessions, resources: ["github:team/project:read"] };

function modelAnswer(tool: boolean, text: string) {
  const content = tool
    ? { type: "tool_use", id: "tool_read", name: "github_read_file", input: {} }
    : { type: "text", text: "" };
  const delta = tool
    ? {
        type: "input_json_delta",
        partial_json: JSON.stringify({ repo: "team/project", path: "README.md", ref: "main" }),
      }
    : { type: "text_delta", text };
  return [
    {
      type: "message_start",
      message: {
        id: "msg_delivery",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: content },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

async function until<T>(
  read: () => Promise<T>,
  matches: (value: T) => boolean,
  timeout = 12_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (matches(value)) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (Date.now() < deadline);
  throw new Error("Delivery did not reach expected observable state");
}

test("execution grants reject missing session/resource authority and canonicalize only authenticated grants", () => {
  assert.throws(() => executionGrant("tools", undefined), /execution_forbidden/);
  assert.throws(() => executionGrant("private", member), /execution_forbidden/);
  assert.throws(
    () => executionGrant("tools", { ...member, resources: ["x".repeat(257)] }),
    /execution_forbidden/,
  );
  assert.deepEqual(executionGrant("tools", { ...member, resources: ["b", "a", "b"] }), {
    sessionId: "tools",
    principal: { id: "member", sessions: ["tools"], resources: ["a", "b"] },
  });
});

test(
  "directory-discovered authenticated delivery survives SQLite reopen, respects 429, bounds retries and supplies persisted tool grants",
  { timeout: 55_000 },
  async () => {
    // Build a directory-owned protocol fixture against the real unchanged Worker/registry/core.
    const root = await mkdtemp(resolve(".delivery-fixture-"));
    let runtime: Miniflare | undefined;
    const deliveries = new Map<string, { at: number; text: string }[]>();
    let githubReads = 0;
    let lastToolResult = "";
    const modelCalls = new Map<string, number>();
    try {
      await cp("src", resolve(root, "server/src"), { recursive: true });
      await cp("tsconfig.json", resolve(root, "server/tsconfig.json"));
      await cp("../shared", resolve(root, "shared"), { recursive: true });
      await cp("../packages", resolve(root, "packages"), { recursive: true });
      const directory = resolve(root, "packages/adapter-probe/src");
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, "index.ts"),
        `
      import { Hono } from 'hono';
      export function create({ execute, authenticate, status }) {
        const app = new Hono();
        app.use('*', authenticate);
        app.post('/', async (c) => {
          const { input, reply } = await c.req.json();
          if (!c.get('principal').sessions.includes(input.sessionId)) return c.json({ error: 'forbidden' }, 403);
          return c.json(await execute(c.env, { adapter: 'probe', input, reply, principal: c.get('principal') }), 202);
        });
        app.get('/:session/:operation', async (c) => {
          if (!c.get('principal').sessions.includes(c.req.param('session'))) return c.json({ error: 'forbidden' }, 403);
          return c.json(await status(c.env, 'probe', c.req.param('session'), c.req.param('operation')));
        });
        return app;
      }
      export async function deliver({ job, result, signal }) {
        const response = await fetch('https://reply.invalid/' + job.reply.kind, {
          method: 'POST', signal, body: JSON.stringify({ operation: job.input.operationId, text: result.text, state: result.status }),
        });
        if (response.ok) return { status: 'delivered' };
        return { status: response.status === 429 || response.status >= 500 ? 'retry' : 'failed',
          code: response.status === 429 ? 'rate_limited' : 'reply_rejected',
          retryAfterMs: Number(response.headers.get('retry-after') || 0) * 1000 };
      }
    `,
      );
      const built = await build({
        root,
        configFile: false,
        logLevel: "silent",
        resolve: { conditions: ["workerd", "worker", "browser"] },
        build: {
          write: false,
          target: "es2022",
          minify: false,
          lib: { entry: resolve(root, "server/src/index.ts"), formats: ["es"] },
          rollupOptions: {
            external: /^(cloudflare:|node:)/,
            output: { inlineDynamicImports: true },
          },
        },
      });
      const output = Array.isArray(built) ? built[0] : built;
      assert("output" in output);
      const entry = output.output.find((item) => item.type === "chunk" && item.isEntry);
      assert(entry?.type === "chunk");
      const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString();
      const options = {
        modules: [
          { type: "ESModule" as const, path: resolve(root, "worker.js"), contents: entry.code },
        ],
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          SESSIONS: { className: "SessionAgent", useSQLite: true },
          ADAPTER_JOBS: { className: "AdapterJobs", useSQLite: true },
        },
        durableObjectsPersist: resolve(root, "state"),
        bindings: {
          TEAM_AUTH: JSON.stringify([
            member,
            { ...member, id: "other", token: `${token}-other`, resources: [] },
          ]),
          MODEL_PROVIDER: "anthropic",
          MODEL_ID: "claude-sonnet-4-5",
          ANTHROPIC_API_KEY: "fake-local-model",
          GITHUB_APP_ID: "123",
          GITHUB_APP_PRIVATE_KEY: key,
          GITHUB_REPOSITORIES: JSON.stringify({ "team/project": 456 }),
        },
        outboundService: async (request: Request) => {
          const url = new URL(request.url);
          if (url.hostname === "api.anthropic.com") {
            const body = await request.text();
            modelCalls.set(
              body.includes("read allowed") ? "tools" : "plain",
              (modelCalls.get(body.includes("read allowed") ? "tools" : "plain") ?? 0) + 1,
            );
            const wantsTool = body.includes("read allowed");
            const hasResult = body.includes("tool_result");
            if (hasResult) lastToolResult = body;
            return new WorkerResponse(
              modelAnswer(
                wantsTool && !hasResult,
                wantsTool ? (body.includes("authorized-file") ? "AUTHORIZED" : "DENIED") : "Answer",
              ),
              { headers: { "Content-Type": "text/event-stream" } },
            );
          }
          if (url.hostname === "api.github.com") {
            if (url.pathname === "/app/installations/456/access_tokens")
              return WorkerResponse.json({
                token: "fake-installation-token",
                expires_at: new Date(Date.now() + 3600_000).toISOString(),
              });
            assert.equal(url.pathname, "/repos/team/project/contents/README.md");
            githubReads++;
            return WorkerResponse.json({
              type: "file",
              encoding: "base64",
              sha: "a".repeat(40),
              content: btoa("authorized-file"),
            });
          }
          assert.equal(url.hostname, "reply.invalid");
          const body = (await request.json()) as { operation: string; text: string };
          const history = deliveries.get(body.operation) ?? [];
          history.push({ at: Date.now(), text: body.text });
          deliveries.set(body.operation, history);
          if (url.pathname === "/permanent") return new WorkerResponse(null, { status: 403 });
          if (url.pathname === "/exhausted") return new WorkerResponse(null, { status: 503 });
          if (url.pathname === "/retry" && history.length === 1)
            return new WorkerResponse(null, { status: 429, headers: { "Retry-After": "2" } });
          return new WorkerResponse(null, { status: 200 });
        },
      };
      runtime = new Miniflare(options);
      let url = await runtime.ready;
      const call = (
        path: string,
        method = "GET",
        body?: unknown,
        auth: Record<string, string> = headers,
      ) =>
        fetch(new URL(path, url), {
          method,
          headers: auth,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(5000),
        });
      const payload = (sessionId: string, kind = sessionId, input = "hello") => ({
        input: { sessionId, operationId: `${sessionId}-op`, input },
        reply: { kind },
      });
      const status = (session: string) =>
        call(`/adapters/probe/${session}/${session}-op`).then((r) => r.json()) as Promise<{
          state: string;
          attempts: number;
          failure: unknown;
        }>;
      assert.equal((await call("/adapters/probe", "POST", payload("retry"), {})).status, 401);
      assert.equal((await call("/adapters/probe", "POST", payload("private"))).status, 403);
      assert.equal(
        (
          await call("/adapters/probe", "POST", {
            ...payload("retry"),
            reply: { data: "x".repeat(8193) },
          })
        ).status,
        400,
      );
      for (const session of ["retry", "permanent"])
        assert.equal((await call("/adapters/probe", "POST", payload(session))).status, 202);
      assert.deepEqual(await (await call("/adapters/probe", "POST", payload("retry"))).json(), {
        accepted: false,
        operationId: "retry-op",
      });
      assert.equal(
        (await call("/adapters/probe", "POST", payload("retry", "changed"))).status,
        409,
      );
      await until(
        () => status("retry"),
        (value) => value.attempts === 1 && value.state === "delivering",
      );
      await until(
        () => status("permanent"),
        (value) => value.state === "failed",
      );
      await runtime.dispose();
      runtime = new Miniflare(options);
      url = await runtime.ready;
      assert.equal(
        (
          await until(
            () => status("retry"),
            (value) => value.state === "delivered",
          )
        ).attempts,
        2,
      );
      const retried = deliveries.get("retry-op")!;
      assert.equal(retried.length, 2);
      assert(retried[1].at - retried[0].at >= 1900, "429 Retry-After must survive eviction/reopen");
      assert.equal(retried[1].text, "Answer");
      assert.deepEqual(
        (
          await until(
            () => status("permanent"),
            (value) => value.state === "failed",
          )
        ).failure,
        { code: "reply_rejected", attempts: 1 },
      );
      assert.equal(deliveries.get("permanent-op")?.length, 1);

      // Persist the authenticated logical session/resource grant, then reopen before exercising a tool.
      assert.equal(
        (
          await call("/adapters/webhook", "POST", {
            sessionId: "tools",
            operationId: "initial",
            input: "hello",
          })
        ).status,
        202,
      );
      await until(
        () => call("/api/sessions/tools/operations/initial").then((r) => r.json()),
        (value: any) => value.status === "done",
      );
      await runtime.dispose();
      runtime = new Miniflare(options);
      url = await runtime.ready;
      assert.equal((await call("/adapters/probe", "POST", payload("exhausted"))).status, 202);
      assert.equal(
        (await call("/adapters/probe", "POST", payload("tools", "success", "read allowed"))).status,
        202,
      );
      await until(
        () => status("tools"),
        (value) => value.state === "delivered",
      );
      assert.match(lastToolResult, /authorized-file/);
      assert.equal(deliveries.get("tools-op")?.[0].text, "AUTHORIZED");
      assert.equal(
        githubReads,
        1,
        "The real tool must receive the authorized persisted resource and logical session",
      );
      assert.equal(
        (
          await call(
            "/adapters/webhook",
            "POST",
            { sessionId: "tools", operationId: "escalate", input: "read allowed" },
            { ...headers, Authorization: `Bearer ${token}-other` },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call("/adapters/probe", "POST", payload("denied", "success", "read allowed"), {
            ...headers,
            Authorization: `Bearer ${token}-other`,
          })
        ).status,
        202,
      );
      await until(
        () => status("denied"),
        (value) => value.state === "delivered",
      );
      assert.equal(deliveries.get("denied-op")?.[0].text, "DENIED");
      assert.equal(githubReads, 1, "Session access alone must never authorize a GitHub read");
      const exhausted = await until(
        () => status("exhausted"),
        (value) => value.state === "failed",
        38_000,
      );
      assert.deepEqual(exhausted.failure, { code: "reply_rejected", attempts: 6 });
      assert.equal(deliveries.get("exhausted-op")?.length, 6);
      const attempts = deliveries.get("exhausted-op")!;
      for (let index = 1; index < attempts.length; index++)
        assert(attempts[index].at - attempts[index - 1].at >= 900 * 2 ** (index - 1));
      assert.equal(
        modelCalls.get("plain"),
        4,
        "Reply retries and duplicate acceptance must not rerun Pi",
      );
      assert.deepEqual(await (await call("/adapters/probe", "POST", payload("exhausted"))).json(), {
        accepted: false,
        operationId: "exhausted-op",
      });
      for (let index = 0; index < 100; index++) {
        const job = payload("queue", "permanent");
        job.input.operationId = `queued-${index}`;
        assert.equal((await call("/adapters/probe", "POST", job)).status, 202);
      }
      const overflow = payload("queue");
      overflow.input.operationId = "overflow";
      const rejected = await call("/adapters/probe", "POST", overflow);
      assert.equal(rejected.status, 429);
      assert.deepEqual(await rejected.json(), { error: { code: "delivery_queue_full" } });
    } finally {
      await runtime?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
