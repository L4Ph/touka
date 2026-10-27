import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { resolve } from "node:path";
import { Miniflare, Response as WorkerResponse } from "miniflare";

const secret = "local-ingress-secret";
const token = "local-member-token-at-least-32-bytes";
const actors = ["alice", "bob", "carol", "dave", "eve", "frank"];
const session = (number: number) => `github_${createHash("sha256").update(`team/project#${number}`).digest("hex")}`;

async function runtime() {
  const { build } = await import("vite");
  const entry = resolve("src/index.ts");
  const testEntry = resolve("ingress-test-entry.ts");
  // Replace only the clock boundary in the test bundle; routes, executeAdapter and DOs stay real.
  const result = await build({
    configFile: false, logLevel: "silent",
    plugins: [{
      name: "ingress-test-clock",
      resolveId(id) { if (id === testEntry) return "\0ingress-test-entry"; },
      load(id) {
        if (id !== "\0ingress-test-entry") return;
        return `import app from ${JSON.stringify(entry)};
          export * from ${JSON.stringify(entry)};
          export default { fetch(request, env, ctx) {
            globalThis.__ingressNow = Number(request.headers.get("x-test-now"));
            return app.fetch(request, env, ctx);
          } };`;
      },
      transform(code, id) {
        if (id !== resolve("../packages/adapter-github/src/index.ts")) return;
        return `const Date = class extends globalThis.Date {
          static now() { return globalThis.__ingressNow ?? super.now(); }
        };\n${code}`;
      },
    }],
    resolve: { conditions: ["workerd", "worker", "browser"] },
    build: {
      write: false, target: "es2022", minify: false,
      lib: { entry: testEntry, formats: ["es"] },
      rollupOptions: { external: /^(cloudflare:|node:)/, output: { inlineDynamicImports: true } },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  assert("output" in output);
  const chunk = output.output.find((item) => item.type === "chunk" && item.isEntry);
  assert(chunk?.type === "chunk");
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
  return new Miniflare({
    modules: [{ type: "ESModule", path: resolve("dist/ingress-rate-test.js"), contents: chunk.code }],
    compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      SESSIONS: { className: "SessionAgent", useSQLite: true },
      ADAPTER_JOBS: { className: "AdapterJobs", useSQLite: true },
    },
    bindings: {
      GITHUB_WEBHOOK_SECRET: secret, GITHUB_BOT_LOGIN: "helper[bot]", GITHUB_ACTORS: JSON.stringify(actors),
      GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_REPOSITORIES: '{"team/project":456}',
      MODEL_PROVIDER: "anthropic", MODEL_ID: "claude-sonnet-4-5", ANTHROPIC_API_KEY: "fake-local-key",
      TEAM_AUTH: JSON.stringify([{ id: "member", token,
        sessions: Array.from({ length: 1100 }, (_, i) => session(i + 1)), resources: [] }]),
    },
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "api.anthropic.com") {
        const events = [
          { type: "message_start", message: { id: "msg_quota", type: "message", role: "assistant",
            model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 2, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Quota answer" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ];
        return new WorkerResponse(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
          { headers: { "Content-Type": "text/event-stream" } });
      }
      assert.equal(url.hostname, "api.github.com", "No unexpected external traffic");
      if (url.pathname === "/app/installations/456/access_tokens")
        return WorkerResponse.json({ token: "fake-installation-token", expires_at: new Date(Date.now() + 3600000).toISOString() });
      assert.match(url.pathname, /^\/repos\/team\/project\/issues\/\d+\/comments$/);
      assert.equal(request.method, "POST");
      return WorkerResponse.json({ id: 999 }, { status: 201 });
    },
  });
}

test("composed GitHub ingress enforces actor and aggregate quotas before durable acceptance and recovers after the window", { timeout: 80000 }, async () => {
  const core = await runtime();
  const worker = await core.getWorker();
  let now = Date.now();
  let delivery = 0;
  const fetchRoute = (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("x-test-now", String(now));
    return worker.fetch(`http://localhost${path}`, { ...init, headers: Object.fromEntries(headers) });
  };
  const send = async (number: number, actor = "alice", valid = true) => {
    const operation = `delivery-${++delivery}`;
    const body = JSON.stringify({
      action: "created", repository: { full_name: "team/project" }, installation: { id: 456 },
      sender: { id: 42, login: actor, type: "User" }, issue: { number },
      comment: { id: number, body: "@helper[bot] Hello", user: { id: 42, login: actor, type: "User" } },
    });
    const signature = createHmac("sha256", valid ? secret : "wrong-secret").update(body).digest("hex");
    const response = await fetchRoute("/adapters/github", { method: "POST", body, headers: {
      "x-hub-signature-256": `sha256=${signature}`, "x-github-event": "issue_comment", "x-github-delivery": operation,
    } });
    return { response, operation, number };
  };
  const job = (number: number, operation: string) => fetchRoute(`/adapters/github/jobs/team/project/${number}/${operation}`);
  const accepted = async (request: Awaited<ReturnType<typeof send>>) => {
    assert.equal(request.response.status, 202);
    assert.deepEqual(await request.response.json(), { accepted: true, operationId: request.operation });
    assert.equal((await job(request.number, request.operation)).status, 200,
      "A successful ACK must have a real SQLite outbox record");
  };
  const rejected = async (request: Awaited<ReturnType<typeof send>>, delay: string) => {
    assert.equal(request.response.status, 429);
    assert.deepEqual(await request.response.json(), { error: "rate_limited", retryable: true });
    assert.equal(request.response.headers.get("retry-after"), delay);
    assert.equal((await job(request.number, request.operation)).status, 404,
      "Rate-limited requests must not reach durable execute/accept");
    assert.equal((await fetchRoute(`/api/sessions/${session(request.number)}`)).status, 404,
      "A new issue must not create a conversation when ingress is rejected");
  };
  try {
    for (let i = 0; i < 21; i++) assert.equal((await send(900 + i, "alice", false)).response.status, 401);
    assert.equal((await job(900, "delivery-1")).status, 404);
    const batch = await Promise.all(Array.from({ length: 20 }, (_, i) => send(i + 1)));
    for (const request of batch) await accepted(request);
    await rejected(await send(999, "ALICE"), "60");
    await accepted(await send(1000, "bob"));

    now += 59999;
    await rejected(await send(1001), "1");
    now++;
    await accepted(await send(1002));
    // The recovered request used one of alice's 20 slots in the new window.
    let issue = 21;
    for (const actor of actors.slice(0, 5)) {
      const count = actor === "alice" ? 19 : 20;
      for (let i = 0; i < count; i++) await accepted(await send(issue++, actor));
    }
    await rejected(await send(1003, "frank"), "60");
    now += 60000;
    await accepted(await send(1003, "frank"));
  } finally {
    await core.dispose();
  }
});
