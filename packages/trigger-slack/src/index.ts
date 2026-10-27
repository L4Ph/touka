import { Hono } from "hono";
import { slackPolicies, postMessage } from "@remote-agent/connector-slack";
import { SlackApp } from "slack-cloudflare-workers";
import type {
  TriggerAppEnv,
  TriggerDependencies,
  DeliveryHandler,
} from "@remote-agent/trigger-contract";

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

export function create({ execute, status }: TriggerDependencies): Hono<TriggerAppEnv> {
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
      if (
        event.type !== "app_mention" ||
        event.bot_id ||
        event.bot_profile ||
        event.subtype ||
        event.user === workspace.botUserId
      )
        return reply({ ignored: true });
      if (!workspace.actors.includes(event.user)) return reply({ error: "forbidden" }, 403);
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
      const receipt = await execute(c.env, {
        trigger: "slack",
        input: { sessionId: session, operationId: body.event_id, input },
        principal: { id: workspace.id, sessions: [session], resources: workspace.resources ?? [] },
        reply: { team: workspace.id, channel: event.channel, thread },
      });
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
  return postMessage(
    env,
    String(job.reply.team),
    String(job.reply.channel),
    String(job.reply.thread),
    text,
  );
};
