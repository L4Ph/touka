import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { Miniflare, Response as WorkerResponse } from "miniflare";

const secret = "local-slack-signing-secret";
const admin = "local-slack-admin-token";
const workspace = [{ id: "T1", actors: ["U1"], botUserId: "B1", token: "local-bot-token" }];
async function bundle(entry: string, name: string) {
  const result = await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["workerd", "worker", "browser"] },
    build: {
      write: false,
      target: "es2022",
      minify: false,
      lib: { entry: resolve(entry), formats: ["es"] },
      rollupOptions: { external: /^(cloudflare:|node:)/, output: { inlineDynamicImports: true } },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  assert("output" in output);
  const chunk = output.output.find((item) => item.type === "chunk" && item.isEntry);
  assert(chunk?.type === "chunk");
  return [
    {
      type: "ESModule" as const,
      path: resolve(`dist/slack-test-${name}.js`),
      contents: chunk.code,
    },
  ];
}
const coreModules = await bundle("src/index.ts", "core");
function payload(eventId: string, event: Record<string, unknown> = {}, team = "T1") {
  return {
    type: "event_callback",
    team_id: team,
    event_id: eventId,
    event: {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "1234567890.123456",
      text: "<@B1> Hello",
      ...event,
    },
  };
}
function signed(body: unknown, ts = String(Math.floor(Date.now() / 1000))) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return {
    method: "POST",
    body: raw,
    headers: {
      "x-slack-request-timestamp": ts,
      "x-slack-signature": `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`,
    },
  };
}
function answer() {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_slack",
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
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Thread answer" } },
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
async function until<T>(read: () => Promise<T>, predicate: (value: T) => boolean) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise<void>((done) => setImmediate(done));
  }
  assert.fail("Slack job did not reach its expected durable state");
}
function options(state: string, outboundService: (request: Request) => Promise<WorkerResponse>) {
  const common = { compatibilityDate: "2026-08-01", compatibilityFlags: ["nodejs_compat"] };
  return {
    durableObjectsPersist: state,
    workers: [
      {
        ...common,
        name: "core",
        modules: coreModules,
        outboundService,
        bindings: {
          MODEL_PROVIDER: "anthropic",
          MODEL_ID: "claude-sonnet-4-5",
          ANTHROPIC_API_KEY: "local-fake-key",
          SLACK_SIGNING_SECRET: secret,
          SLACK_ADMIN_TOKEN: admin,
          SLACK_WORKSPACES: JSON.stringify(workspace),
        },
        durableObjects: {
          SESSIONS: { className: "SessionAgent", useSQLite: true },
          ADAPTER_JOBS: { className: "AdapterJobs", useSQLite: true },
        },
      },
      { ...common, name: "unconfigured", modules: coreModules },
      {
        ...common,
        name: "missing-outbox",
        modules: coreModules,
        bindings: {
          SLACK_SIGNING_SECRET: secret,
          SLACK_ADMIN_TOKEN: admin,
          SLACK_WORKSPACES: JSON.stringify(workspace),
        },
      },
    ],
  };
}

test(
  "Slack authenticates raw bodies, rejects stale and forbidden requests, and filters nonhuman mentions",
  { timeout: 15000 },
  async () => {
    const state = await mkdtemp(join(tmpdir(), "slack-auth-"));
    const runtime = new Miniflare(
      options(state, async () => {
        assert.fail("Rejected requests must not reach external services");
      }),
    );
    try {
      const core = await runtime.getWorker("core");
      const unconfigured = await runtime.getWorker("unconfigured");
      const missingOutbox = await runtime.getWorker("missing-outbox");
      const notAccepted = await missingOutbox.fetch(
        "http://localhost/adapters/slack",
        signed(payload("no-outbox")),
      );
      assert.equal(
        notAccepted.status,
        503,
        "The library must not ACK when durable acceptance fails",
      );
      assert.deepEqual(await notAccepted.json(), { error: { code: "delivery_unconfigured" } });
      assert.equal(
        (
          await unconfigured.fetch(
            "http://localhost/adapters/slack",
            signed(payload("missing-config")),
          )
        ).status,
        503,
      );
      assert.equal(
        (await core.fetch("http://localhost/adapters/slack", { method: "POST", body: "{}" }))
          .status,
        401,
      );
      const send = (body: unknown, ts?: string) =>
        core.fetch("http://localhost/adapters/slack", signed(body, ts));
      const challenge = await send({ type: "url_verification", challenge: "challenge-value" });
      assert.equal(challenge.status, 200);
      assert.equal(await challenge.text(), "challenge-value");
      const invalid = signed(payload("invalid"));
      invalid.body += " ";
      assert.equal(
        (await core.fetch("http://localhost/adapters/slack", invalid)).status,
        401,
        "Signature covers exact raw bytes, not parsed JSON",
      );
      assert.equal(
        (await send(payload("stale"), String(Math.floor(Date.now() / 1000) - 301))).status,
        401,
      );
      assert.equal(
        (await send(payload("future"), String(Math.floor(Date.now() / 1000) + 400))).status,
        401,
      );
      assert.equal((await send(payload("actor", { user: "U2" }))).status, 403);
      assert.equal(
        (await send(payload("team", {}, "T2"))).status,
        403,
        "An allowed actor cannot cross workspaces",
      );
      for (const event of [
        { bot_id: "bot" },
        { subtype: "message_changed" },
        { user: "B1" },
        { type: "message" },
      ]) {
        const response = await send(payload("ignored", event));
        assert.deepEqual(await response.json(), { ignored: true });
      }
      assert.equal((await send("{")).status, 400);
      assert.equal(
        (await send(payload("legacy-ssl-check", { text: "<@B1> &ssl_check=1&token=x" }))).status,
        400,
        "Legacy ssl_check auto-ACK must never bypass durable acceptance for JSON events",
      );
      assert.equal((await send(payload("bad-thread", { thread_ts: "../bad" }))).status, 400);
      assert.equal((await send("x".repeat(32769))).status, 413);
      assert.equal(
        (await core.fetch("http://localhost/adapters/slack/jobs/T1/C1/1234567890.123456/ignored"))
          .status,
        401,
      );
      assert.equal(
        (
          await core.fetch("http://localhost/adapters/slack/jobs/T1/C1/1234567890.123456/ignored", {
            headers: { Authorization: `Bearer ${admin}` },
          })
        ).status,
        404,
      );
    } finally {
      await runtime.dispose();
      await rm(state, { recursive: true, force: true });
    }
  },
);

test(
  "durable Slack outbox deduplicates, survives restart, respects Retry-After, replies in thread and exposes terminal failure",
  { timeout: 55000 },
  async () => {
    const state = await mkdtemp(join(tmpdir(), "slack-outbox-"));
    const replies: { at: number; body: any }[] = [];
    const modelInputs: any[] = [];
    let rejectAuth = false;
    let releaseModel: (() => void) | undefined;
    const gate = new Promise<void>((done) => {
      releaseModel = done;
    });
    const config = options(state, async (request) => {
      const url = new URL(request.url);
      if (url.hostname === "api.anthropic.com") {
        modelInputs.push(await request.json());
        await gate;
        return new WorkerResponse(answer(), { headers: { "Content-Type": "text/event-stream" } });
      }
      assert.equal(url.href, "https://slack.com/api/chat.postMessage");
      assert.equal(request.headers.get("authorization"), "Bearer local-bot-token");
      replies.push({ at: Date.now(), body: await request.json() });
      if (rejectAuth) return WorkerResponse.json({ ok: false, error: "invalid_auth" });
      if (replies.length === 1)
        return new WorkerResponse("", { status: 429, headers: { "Retry-After": "3" } });
      return WorkerResponse.json({ ok: true, ts: "1234567891.000001" });
    });
    let runtime = new Miniflare(config);
    let core = await runtime.getWorker("core");
    let statusUrl = await runtime.ready;
    const send = (body: unknown) => core.fetch("http://localhost/adapters/slack", signed(body));
    const status = async (eventId: string) => {
      const response = await fetch(
        new URL(`/adapters/slack/jobs/T1/C1/1234567890.123456/${eventId}`, statusUrl),
        { headers: { Authorization: `Bearer ${admin}` } },
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
      assert.deepEqual(await (await send(payload("Ev1"))).json(), {
        eventId: "Ev1",
        accepted: true,
      });
      assert(
        ["queued", "waiting"].includes((await status("Ev1")).state),
        "ACK follows durable inbox write, not model completion",
      );
      await until(
        async () => modelInputs.length,
        (n) => n === 1,
      );
      assert.equal(replies.length, 0, "The webhook does not wait for the model");
      const duplicates = await Promise.all([send(payload("Ev1")), send(payload("Ev1"))]);
      for (const response of duplicates)
        assert.deepEqual(await response.json(), { eventId: "Ev1", accepted: false });
      assert.equal(modelInputs[0].system, undefined);
      assert.deepEqual(
        modelInputs[0].messages[0].content.map((block: { text?: string }) => block.text),
        ["Hello"],
      );
      releaseModel!();
      await until(
        async () => replies.length,
        (n) => n === 1,
      );
      await until(
        () => status("Ev1"),
        (j) => j.state === "delivering" && j.attempts === 1 && j.due >= replies[0].at + 3000,
      );
      await runtime.dispose();
      runtime = new Miniflare(config);
      core = await runtime.getWorker("core");
      statusUrl = await runtime.ready;
      assert.deepEqual(await (await send(payload("Ev1"))).json(), {
        eventId: "Ev1",
        accepted: false,
      });
      const delivered = await until(
        () => status("Ev1"),
        (j) => j.state === "delivered",
      );
      assert.equal(delivered.attempts, 2);
      assert.equal(replies.length, 2);
      assert(replies[1].at - replies[0].at >= 3000, "Retry-After survives a runtime restart");
      assert.deepEqual(replies[1].body, {
        channel: "C1",
        thread_ts: "1234567890.123456",
        text: "Thread answer",
        mrkdwn: false,
        unfurl_links: false,
        unfurl_media: false,
      });
      assert.equal(modelInputs.length, 1, "Delivery retries must not repeat model work");
      rejectAuth = true;
      assert.equal(
        (await send(payload("Ev2", { ts: "1234567891.123456", thread_ts: "1234567890.123456" })))
          .status,
        200,
      );
      const failed = await until(
        () => status("Ev2"),
        (j) => j.state === "failed",
      );
      assert.deepEqual(failed.failure, { code: "slack_api_error", attempts: 1 });
      assert.equal(
        modelInputs[1].messages.length,
        3,
        "Later mentions in a thread reuse its core history",
      );
      assert.equal(replies.length, 3, "Permanent auth errors must not retry");
      assert.deepEqual(await (await send(payload("Ev2"))).json(), {
        eventId: "Ev2",
        accepted: false,
      });
      await runtime.dispose();
      runtime = new Miniflare(config);
      core = await runtime.getWorker("core");
      statusUrl = await runtime.ready;
      assert.deepEqual(
        await status("Ev2"),
        failed,
        "Terminal failure remains visible after restart",
      );
    } finally {
      releaseModel!();
      await runtime.dispose();
      await rm(state, { recursive: true, force: true });
    }
  },
);
