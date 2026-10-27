import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { globSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, Response as WorkerResponse } from "miniflare";

const app = "111111111111111111";
const guild = "222222222222222222";
const channel = "333333333333333333";
const actor = "444444444444444444";
const session = `discord_${guild}_${channel}`;
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey
  .export({ type: "spki", format: "der" })
  .subarray(-32)
  .toString("hex");
let sequence = 0n;
function interaction(conversation = channel) {
  return {
    type: 2,
    id: (((BigInt(Date.now()) - 1420070400000n) << 22n) + sequence++).toString(),
    application_id: app,
    guild_id: guild,
    channel_id: conversation,
    member: { user: { id: actor } },
    token: "private-interaction-token",
    data: { name: "ask", type: 1, options: [{ name: "prompt", type: 3, value: "Do the task" }] },
  };
}
function answer() {
  return [
    {
      type: "message_start",
      message: {
        id: "msg_discord",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Discord answer" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: "message_stop" },
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}
async function until<T>(read: () => Promise<T>, match: (v: T) => boolean) {
  const deadline = Date.now() + 12000;
  do {
    const value = await read();
    if (match(value)) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  } while (Date.now() < deadline);
  assert.fail("Discord delivery did not reach expected state");
}

test(
  "Discord composition bounds acceptance before ACK, dedupes, isolates conversations and reopens delivery",
  { timeout: 40000 },
  async () => {
    const state = await mkdtemp(join(tmpdir(), "discord-runtime-"));
    let calls = 0;
    let replyCount = 0;
    let replyAt = 0;
    let expired = false;
    let replyGate: Promise<void> | undefined;
    let replyEntered: (() => void) | undefined;
    let releaseReply: (() => void) | undefined;
    let releaseModel!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const options = {
      name: "core",
      serviceBindings: { TEAM_VIEW: { name: "core", entrypoint: "WebGateway" } },
      modules: [
        "dist/remote_agent_server/index.js",
        ...globSync("dist/remote_agent_server/assets/*.js"),
      ].map((path) => ({ type: "ESModule" as const, path })),
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: {
        SESSIONS: { className: "SessionAgent", useSQLite: true },
        ADAPTER_JOBS: { className: "AdapterJobs", useSQLite: true },
        SESSION_DIRECTORY: { className: "SessionDirectory", useSQLite: true },
      },
      durableObjectsPersist: state,
      bindings: {
        DISCORD_APPLICATION_ID: app,
        DISCORD_PUBLIC_KEY: publicKey,
        DISCORD_ADMIN_TOKEN: "operator-secret",
        DISCORD_GUILDS: JSON.stringify([{ id: guild, actors: [actor] }]),
        TEAM_AUTH: JSON.stringify([
          {
            id: "operator",
            token: "discord-machine-token-000000000000",
            sessions: [],
            resources: [],
          },
        ]),
        MODEL_PROVIDER: "anthropic",
        MODEL_ID: "claude-sonnet-4-5",
        ANTHROPIC_API_KEY: "fake-model-key",
      },
      outboundService: async (request: Request) => {
        const url = new URL(request.url);
        if (url.hostname === "api.anthropic.com") {
          calls++;
          await modelGate;
          return new WorkerResponse(answer(), { headers: { "content-type": "text/event-stream" } });
        }
        assert.equal(url.hostname, "discord.com");
        assert.equal(
          url.pathname,
          `/api/v10/webhooks/${app}/private-interaction-token/messages/@original`,
        );
        assert.equal(request.method, "PATCH");
        assert.deepEqual(await request.json(), {
          content: "Discord answer",
          allowed_mentions: { parse: [] },
        });
        replyCount++;
        if (replyGate) {
          replyEntered?.();
          await replyGate;
        }
        if (expired) return new WorkerResponse(null, { status: 404 });
        if (replyCount === 1) {
          replyAt = Date.now();
          return new WorkerResponse(null, { status: 429, headers: { "retry-after": "2" } });
        }
        assert.ok(Date.now() - replyAt >= 1900, "vendor retry-after must survive reopen");
        return new WorkerResponse(null, { status: 200 });
      },
    };
    let runtime = new Miniflare(options);
    let url = await runtime.ready;
    const post = async (
      body: unknown,
      settings: { timestamp?: string; corrupt?: boolean; raw?: string } = {},
    ) => {
      const raw = settings.raw ?? JSON.stringify(body);
      const timestamp = settings.timestamp ?? String(Math.floor(Date.now() / 1000));
      const signature = sign(null, Buffer.from(timestamp + raw), keys.privateKey).toString("hex");
      return fetch(new URL("/adapters/discord", url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-timestamp": timestamp,
          "x-signature-ed25519": settings.corrupt ? "0".repeat(128) : signature,
        },
        body: raw,
        signal: AbortSignal.timeout(3000),
      });
    };
    const status = async (id: string, conversation = channel) => {
      const response = await fetch(
        new URL(`/adapters/discord/jobs/${guild}/${conversation}/${id}`, url),
        { headers: { authorization: "Bearer operator-secret" } },
      );
      assert.equal(response.status, 200);
      return response.json() as Promise<{ state: string; attempts: number; failure: unknown }>;
    };
    try {
      assert.equal(
        (
          await post({
            ...interaction(),
            id: ((BigInt(Date.now() - 900000) - 1420070400000n) << 22n).toString(),
          })
        ).status,
        503,
      );
      assert.equal(calls, 0, "rejected inputs must not start model work");
      const input = interaction();
      const accepted = await post(input);
      assert.equal(accepted.status, 200);
      assert.deepEqual(await accepted.json(), { type: 5, data: {} });
      assert.equal((await post(input)).status, 200);
      assert.ok(
        ["queued", "waiting"].includes((await status(input.id)).state),
        "deferred ACK must precede model completion while durable job is already observable",
      );
      releaseModel();
      await until(
        () => status(input.id),
        (s) => s.state === "delivering" && s.attempts === 1,
      );
      await runtime.dispose();
      runtime = new Miniflare(options);
      url = await runtime.ready;
      const delivered = await until(
        () => status(input.id),
        (s) => s.state === "delivered",
      );
      assert.equal(delivered.attempts, 2);
      assert.equal(delivered.failure, null);
      assert.equal(replyCount, 2);
      assert.equal(calls, 1);
      const { TEAM_VIEW } = await runtime.getBindings<{ TEAM_VIEW: { fetch: typeof fetch } }>();
      const list = await TEAM_VIEW.fetch("https://core.internal/api/sessions", {
        headers: { "x-team-user": "verified-team-member" },
      });
      assert.equal(list.status, 200);
      assert.ok(
        JSON.stringify(await list.json()).includes(session),
        "adapter conversation must be team-discoverable",
      );
      assert.equal(
        (await fetch(new URL(`/adapters/discord/jobs/${guild}/${channel}/${input.id}`, url)))
          .status,
        401,
      );
      expired = true;
      const expiring = interaction();
      assert.equal((await post(expiring)).status, 200);
      const failed = await until(
        () => status(expiring.id),
        (s) => s.state === "failed",
      );
      assert.deepEqual(failed.failure, { code: "interaction_token_expired", attempts: 1 });
      assert.equal(replyCount, 3, "expired tokens must not trigger bot fallback or retries");
      for (let attempt = 0; attempt < 19; attempt++) assert.equal((await post(input)).status, 200);
      const limited = await post(input);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get("retry-after")) > 0);
      assert.equal(calls, 2, "duplicate retries must not submit more Pi operations");
      await runtime.dispose();
      runtime = new Miniflare(options);
      url = await runtime.ready;
      expired = false;
      const thread = "555555555555555555";
      const sibling = "666666666666666666";
      const conversations = [channel, thread, sibling, thread];
      const submitted = [];
      for (const [index, conversation] of conversations.entries()) {
        const next = interaction(conversation);
        next.data.options[0].value = `Conversation task ${index}`;
        assert.equal((await post(next)).status, 200);
        await until(
          () => status(next.id, conversation),
          (s) => s.state === "delivered",
        );
        submitted.push(next);
      }
      const { TEAM_VIEW: viewer } = await runtime.getBindings<{
        TEAM_VIEW: { fetch: typeof fetch };
      }>();
      const shared = await viewer.fetch("https://core.internal/api/sessions", {
        headers: { "x-team-user": "verified-team-member" },
      });
      const directory = (await shared.json()) as { sessions: { sessionId: string }[] };
      assert.deepEqual(
        directory.sessions.map((s) => s.sessionId).sort(),
        [channel, thread, sibling].map((id) => `discord_${guild}_${id}`).sort(),
      );
      for (const conversation of [channel, thread, sibling]) {
        const transcript = await viewer.fetch(
          `https://core.internal/api/sessions/discord_${guild}_${conversation}/messages`,
          {
            headers: { "x-team-user": "verified-team-member" },
          },
        );
        assert.equal(transcript.status, 200);
        const messages = JSON.stringify(await transcript.json());
        for (const [index, input] of submitted.entries()) {
          assert.equal(
            messages.includes(`Conversation task ${index}`),
            input.channel_id === conversation,
            "same-channel operations share history; parent and sibling threads cannot see each other's inputs",
          );
        }
      }
      replyGate = new Promise<void>((resolve) => {
        releaseReply = resolve;
      });
      const sending = new Promise<void>((resolve) => {
        replyEntered = resolve;
      });
      const blocking = interaction();
      assert.equal((await post(blocking)).status, 200);
      await sending;
      // The real alarm holds this conversation's concurrency gate during the vendor send.
      const delayed = interaction();
      const started = performance.now();
      const deadlineResponse = await post(delayed);
      assert.equal(deadlineResponse.status, 503, "blocked durable acceptance cannot defer-ACK");
      assert.deepEqual(await deadlineResponse.json(), { error: "discord_unavailable" });
      assert.ok(
        performance.now() - started < 3000,
        "initial response must meet Discord's deadline",
      );
      replyGate = undefined;
      releaseReply?.();
      await until(
        () => status(blocking.id),
        (s) => s.state === "delivered",
      );
      await runtime.dispose();
      runtime = new Miniflare({
        ...options,
        durableObjects: {
          SESSIONS: options.durableObjects.SESSIONS,
          SESSION_DIRECTORY: options.durableObjects.SESSION_DIRECTORY,
        },
      });
      url = await runtime.ready;
      const rejected = await post(interaction());
      assert.equal(
        rejected.status,
        503,
        "missing durable acceptance must not return deferred success",
      );
      assert.equal(
        JSON.stringify(await rejected.json()).includes("private-interaction-token"),
        false,
      );
    } finally {
      releaseReply?.();
      releaseModel();
      await runtime.dispose();
      await rm(state, { recursive: true, force: true });
    }
  },
);
