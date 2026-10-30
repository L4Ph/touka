import type nodeAssert from "node:assert/strict";
import type { TriggerDependencies, TriggerExecution } from "@remote-agent/trigger-contract";
import { Hono } from "hono";
import {
  slackPolicies,
  postMessage,
  readThread,
  setReactions,
} from "@remote-agent/connector-slack";
import { sample, unseen, withContext } from "./thread";
import { SlackApp } from "slack-cloudflare-workers";
import type { TriggerAppEnv, DeliveryHandler } from "@remote-agent/trigger-contract";

const reply = (body: Record<string, unknown>, status = 200) => ({
  status,
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const timestamp = (v: unknown): v is string =>
  typeof v === "string" && /^\d{1,16}\.\d{1,6}$/.test(v);
async function sessionId(team: string, channel: string, thread: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([team, channel, thread])),
  );
  return `slack_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function create({
  execute,
  status,
  exists,
  addressed,
}: TriggerDependencies): Hono<TriggerAppEnv> {
  const app = new Hono<TriggerAppEnv>();
  app.get("/jobs/:team/:channel/:thread/:operation", async (c) => {
    if (!c.env.SLACK_ADMIN_TOKEN) return c.json({ error: "slack_unconfigured" }, 503);
    if (c.req.header("authorization") !== `Bearer ${c.env.SLACK_ADMIN_TOKEN}`)
      return c.json({ error: "unauthorized" }, 401);
    const { team, channel, thread, operation } = c.req.param();
    if (!id(team) || !id(channel) || !timestamp(thread) || !id(operation))
      return c.json({ error: "invalid_payload" }, 400);
    const job = await status(c.env, "slack", await sessionId(team, channel, thread), operation);
    return job ? c.json(job) : c.json({ error: "not_found" }, 404);
  });
  app.post("/", async (c) => {
    let configured: ReturnType<typeof slackPolicies>;
    try {
      if (!c.env.SLACK_SIGNING_SECRET || !c.env.SLACK_ADMIN_TOKEN)
        throw new Error("slack_unconfigured");
      configured = slackPolicies(c.env);
    } catch {
      return c.json({ error: "slack_unconfigured" }, 503);
    }
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 32768) {
          await reader.cancel();
          return c.json({ error: "payload_too_large" }, 413);
        }
        chunks.push(value);
      }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const ts = c.req.header("x-slack-request-timestamp") ?? "";
    const signature = c.req.header("x-slack-signature") ?? "";
    // The library rejects old requests, but not future timestamps or malformed signature prefixes.
    if (
      !/^\d{10,12}$/.test(ts) ||
      Math.abs(Date.now() / 1000 - Number(ts)) > 300 ||
      !/^v0=[a-f0-9]{64}$/.test(signature)
    )
      return c.json({ error: "invalid_signature" }, 401);
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_payload" }, 400);
    }
    // SlackApp's legacy form ssl_check shortcut ACKs before signatures/middleware, even inside JSON.
    const legacy = new URLSearchParams(raw);
    if (legacy.get("ssl_check") === "1" && legacy.get("token"))
      return c.json({ error: "invalid_payload" }, 400);
    const slack = new SlackApp({
      env: {
        SLACK_SIGNING_SECRET: c.env.SLACK_SIGNING_SECRET,
        SLACK_BOT_TOKEN: "signature-verification-only",
      },
    });
    // Supported pre-authorize middleware is awaited before automatic event ACK/lazy dispatch.
    // Return the ACK here only after durable acceptance; never put model work in event().
    slack.beforeAuthorize(async ({ body }) => {
      if (body.type !== "event_callback") return reply({ ignored: true });
      const workspace = configured.find((w) => w.id === body.team_id);
      const event = body.event;
      if (!workspace || !event) return reply({ error: "forbidden" }, 403);
      const mention = event.type === "app_mention";
      if (
        (!mention && event.type !== "message") ||
        event.bot_id ||
        event.bot_profile ||
        event.subtype ||
        event.user === workspace.botUserId
      )
        return reply({ ignored: true });
      // Thread messages without a mention: only people who may use the agent, in threads it is part of.
      // The mention itself also arrives as a message event; the app_mention event handles that one.
      if (!mention) {
        if (
          !workspace.actors.includes(event.user) ||
          typeof event.text !== "string" ||
          event.text.includes(`<@${workspace.botUserId}>`) ||
          event.thread_ts === undefined ||
          event.thread_ts === event.ts
        )
          return reply({ ignored: true });
      } else if (!workspace.actors.includes(event.user)) return reply({ error: "forbidden" }, 403);
      if (
        !id(body.event_id) ||
        !id(event.channel) ||
        !timestamp(event.ts) ||
        (event.thread_ts !== undefined && !timestamp(event.thread_ts)) ||
        typeof event.text !== "string" ||
        event.text.length > 16000
      )
        return reply({ error: "invalid_payload" }, 400);
      const input = event.text
        .replace(new RegExp(`<@${workspace.botUserId}>`, "g"), "")
        .replace(/\r\n?/g, "\n")
        .trim();
      if (!input) return reply({ ignored: true });
      const thread = event.thread_ts ?? event.ts;
      const session = await sessionId(workspace.id, event.channel, thread);
      let text = input;
      if (event.thread_ts !== undefined) {
        const history = await readThread(c.env, workspace.id, event.channel, event.thread_ts);
        if (!mention) {
          // Cheapest checks first: a conversation must exist, and history must be readable.
          if (!exists || !addressed || !(await exists(c.env, session)) || !history.length)
            return reply({ ignored: true });
          const excerpt = sample(history, workspace.botUserId, {
            user: event.user,
            text: event.text,
            ts: event.ts,
          });
          if (!(await addressed(c.env, excerpt))) return reply({ ignored: true });
        }
        text = withContext(unseen(history, workspace.botUserId, event.ts), input);
      }
      let receipt;
      try {
        receipt = await execute(c.env, {
          trigger: "slack",
          input: { sessionId: session, operationId: body.event_id, input: text },
          principal: {
            id: workspace.id,
            sessions: [session],
            resources: workspace.resources ?? [],
          },
          reply: { team: workspace.id, channel: event.channel, thread, ts: event.ts },
        });
      } catch (error) {
        // A refusal that retrying cannot fix (for example, permissions that changed after the
        // conversation began): tell the person, and acknowledge so Slack does not resend it.
        if (
          error instanceof Error &&
          ["execution_grant_conflict", "execution_forbidden"].includes(error.message)
        ) {
          await setReactions(c.env, workspace.id, event.channel, event.ts, { add: ["warning"] });
          return reply({ ignored: true, reason: error.message });
        }
        throw error;
      }
      await setReactions(c.env, workspace.id, event.channel, event.ts, { add: ["eyes"] });
      return reply({ eventId: body.event_id, accepted: receipt.accepted });
    });
    return slack.run(
      new Request(c.req.url, {
        method: "POST",
        headers: { ...Object.fromEntries(c.req.raw.headers), "content-type": "application/json" },
        body: raw,
      }),
    );
  });
  return app;
}

export const deliver: DeliveryHandler = async ({ env, job, result }) => {
  const text =
    result.status === "done"
      ? (result.text || "Completed without a text response.").slice(0, 3900)
      : `Agent operation ${result.status}. Check the session for recovery.`;
  const sent = await postMessage(
    env,
    String(job.reply.team),
    String(job.reply.channel),
    String(job.reply.thread),
    text,
  );
  // The 👀 set on acceptance becomes ✅ (or ❌) once the reply is out.
  if (sent.status === "delivered" && timestamp(job.reply.ts))
    await setReactions(env, String(job.reply.team), String(job.reply.channel), job.reply.ts, {
      remove: ["eyes"],
      add: [result.status === "done" ? "white_check_mark" : "x"],
    });
  return sent;
};

if (import.meta.vitest) {
  const { test, vi } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { createHmac } = await import("node:crypto");

  const secret = "follow-up-signing-secret";
  const env = {
    SLACK_SIGNING_SECRET: secret,
    SLACK_ADMIN_TOKEN: "admin",
    SLACK_WORKSPACES: JSON.stringify([
      { id: "T1", actors: ["U1"], botUserId: "B1", token: "xoxb-test", resources: [] },
    ]),
  };
  const history = [
    { type: "message", user: "U2", text: "deploy looks slow", ts: "10.000001" },
    { type: "message", user: "B1", text: "Checking.", ts: "10.000002", bot_id: "BOT" },
    { type: "message", user: "U2", text: "it was the cache", ts: "10.000003" },
    { type: "message", user: "U1", text: "so we should clear it?", ts: "10.000004" },
  ];

  function setup({ exists = true, addressed = true, refuse = "" } = {}) {
    const executed: TriggerExecution[] = [];
    const calls = { slack: 0, classified: 0 };
    const reactions: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      // The Slack client hands fetch a Request, not a string.
      const url = input instanceof Request ? input.url : String(input);
      if (/reactions\.(add|remove)/.test(url)) {
        const body = input instanceof Request ? await input.text() : "";
        reactions.push(
          `${/reactions\.(add|remove)/.exec(url)![1]}:${new URLSearchParams(body).get("name")}`,
        );
        return Response.json({ ok: true });
      }
      assert.match(url, /conversations\.replies/);
      calls.slack++;
      return Response.json({ ok: true, messages: history });
    });
    const deps: TriggerDependencies = {
      authenticate: async (_c, next) => next(),
      submit: async () => null,
      execute: async (_env, request) => {
        if (refuse) throw new Error(refuse);
        executed.push(request);
        return { accepted: true, operationId: request.input.operationId };
      },
      status: async () => null,
      exists: async () => exists,
      addressed: async () => {
        calls.classified++;
        return addressed;
      },
    };
    const app = create(deps);
    const send = async (event: Record<string, unknown>, eventId = "Ev1") => {
      const raw = JSON.stringify({
        type: "event_callback",
        team_id: "T1",
        event_id: eventId,
        event: { channel: "C1", ts: "10.000004", ...event },
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${raw}`).digest("hex")}`;
      const response = await app.request(
        "/",
        {
          method: "POST",
          body: raw,
          headers: {
            "content-type": "application/json",
            "x-slack-request-timestamp": ts,
            "x-slack-signature": signature,
          },
        },
        env,
      );
      return { status: response.status, body: await response.json() };
    };
    return { send, executed, calls, reactions };
  }
  const reply = {
    type: "message",
    user: "U1",
    text: "so we should clear it?",
    thread_ts: "10.000001",
  };

  test("a thread message the classifier says is for the agent is answered, with the unseen context", async () => {
    const { send, executed, calls } = setup();
    const result = await send(reply);
    assert.deepEqual(result.body, { eventId: "Ev1", accepted: true });
    assert.equal(calls.classified, 1);
    assert.equal(executed.length, 1);
    assert.match(executed[0].input.input, /<@U2>: it was the cache/);
    assert.doesNotMatch(executed[0].input.input, /deploy looks slow|Checking/);
    assert.match(executed[0].input.input, /Message for you:\nso we should clear it\?$/);
    assert.deepEqual(executed[0].reply, {
      team: "T1",
      channel: "C1",
      thread: "10.000001",
      ts: "10.000004",
    });
  });

  test("a thread message the classifier says is not for the agent is left alone", async () => {
    const { send, executed } = setup({ addressed: false });
    assert.deepEqual((await send(reply)).body, { ignored: true });
    assert.equal(executed.length, 0);
  });

  test("threads the agent is not part of are ignored before any Slack or classifier call", async () => {
    const { send, executed, calls } = setup({ exists: false });
    assert.deepEqual((await send(reply)).body, { ignored: true });
    assert.equal(calls.classified + executed.length, 0);
  });

  test("a mention in the message event, a non-thread message, and other people's messages are ignored", async () => {
    const { send, executed, calls } = setup();
    assert.deepEqual((await send({ ...reply, text: "<@B1> look at this" })).body, {
      ignored: true,
    });
    assert.deepEqual((await send({ ...reply, thread_ts: undefined })).body, { ignored: true });
    const stranger = await send({ ...reply, user: "U9" });
    assert.equal(
      stranger.status,
      200,
      "someone outside the allowlist is silently ignored, not refused",
    );
    assert.deepEqual(stranger.body, { ignored: true });
    assert.equal(calls.classified + executed.length, 0);
  });

  test("a mention inside a thread carries the context people added since the agent last replied", async () => {
    const { send, executed, calls } = setup();
    await send({
      type: "app_mention",
      user: "U1",
      text: "<@B1> yes clear it",
      thread_ts: "10.000001",
    });
    assert.equal(calls.classified, 0, "a mention is never second-guessed");
    assert.match(executed[0].input.input, /<@U2>: it was the cache/);
    assert.match(executed[0].input.input, /Message for you:\nyes clear it$/);
  });

  test("an accepted message gets 👀, and the reply record keeps its timestamp for the finishing emoji", async () => {
    const { send, executed, reactions } = setup();
    await send(reply);
    assert.deepEqual(reactions, ["add:eyes"]);
    assert.equal(executed[0].reply.ts, "10.000004");
  });

  test("a refusal retrying cannot fix is acknowledged with ⚠️ instead of failing the event", async () => {
    const { send, executed, reactions } = setup({ refuse: "execution_grant_conflict" });
    const result = await send(reply);
    assert.equal(result.status, 200, "Slack must not resend an event that can never succeed");
    assert.deepEqual(result.body, { ignored: true, reason: "execution_grant_conflict" });
    assert.deepEqual(reactions, ["add:warning"]);
    assert.equal(executed.length, 0);
  });

  test("ignored messages get no reaction", async () => {
    const { send, reactions } = setup({ addressed: false });
    await send(reply);
    assert.deepEqual(reactions, []);
  });

  test("delivering a reply swaps 👀 for ✅, or ❌ when the operation did not answer", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      const body = input instanceof Request ? await input.text() : "";
      const name = new URLSearchParams(body).get("name");
      calls.push(`${url.split("/api/")[1]}${name ? `:${name}` : ""}`);
      return Response.json({ ok: true });
    });
    const job = {
      trigger: "slack",
      input: { sessionId: "s", operationId: "o", input: "x" },
      principal: { id: "p", sessions: ["s"], resources: [] },
      reply: { team: "T1", channel: "C1", thread: "10.000001", ts: "10.000004" },
    };
    const signal = new AbortController().signal;
    await deliver({
      env,
      job,
      result: { sessionId: "s", operationId: "o", status: "done", text: "hi" },
      signal,
    });
    assert.deepEqual(calls, [
      "chat.postMessage",
      "reactions.remove:eyes",
      "reactions.add:white_check_mark",
    ]);
    calls.length = 0;
    await deliver({
      env,
      job,
      result: { sessionId: "s", operationId: "o", status: "unanswered" },
      signal,
    });
    assert.deepEqual(calls.slice(-1), ["reactions.add:x"]);
  });
}
