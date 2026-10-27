import { Hono } from "hono";
import { DiscordHono } from "discord-hono";
import type {
  AdapterAppEnv,
  AdapterDependencies,
  AdapterEnv,
  DeliveryHandler,
} from "@remote-agent/adapter-contract";

const snowflake = (v: unknown): v is string => typeof v === "string" && /^[0-9]{17,20}$/.test(v);
type Guild = { id: string; actors: string[]; resources?: string[] };
function policy(env: AdapterEnv): Guild[] {
  const guilds: unknown = JSON.parse(env.DISCORD_GUILDS ?? "null");
  if (
    !snowflake(env.DISCORD_APPLICATION_ID) ||
    !/^[a-fA-F0-9]{64}$/.test(env.DISCORD_PUBLIC_KEY ?? "") ||
    !env.DISCORD_ADMIN_TOKEN ||
    !Array.isArray(guilds) ||
    !guilds.length ||
    guilds.length > 100 ||
    !guilds.every(
      (g) =>
        snowflake(g?.id) &&
        Array.isArray(g.actors) &&
        g.actors.length > 0 &&
        g.actors.length <= 1000 &&
        g.actors.every(snowflake) &&
        (g.resources === undefined ||
          (Array.isArray(g.resources) &&
            g.resources.length <= 100 &&
            g.resources.every((r: unknown) => typeof r === "string" && r.length <= 256))),
    )
  )
    throw new Error("discord_unconfigured");
  return guilds;
}
function session(guild: string, channel: string) {
  return `discord_${guild}_${channel}`;
}
function createdAt(id: string) {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}

export function create({ execute, status }: AdapterDependencies): Hono<AdapterAppEnv> {
  const app = new Hono<AdapterAppEnv>();
  let windowEnd = 0;
  let ingressCount = 0;
  const actors = new Map<string, number>();
  // Never expose framework exceptions, which can include token-bearing request URLs.
  app.onError(() => Response.json({ error: "discord_unavailable" }, { status: 503 }));
  app.get("/jobs/:guild/:channel/:operation", async (c) => {
    if (!c.env.DISCORD_ADMIN_TOKEN) return c.json({ error: "discord_unconfigured" }, 503);
    if (c.req.header("authorization") !== `Bearer ${c.env.DISCORD_ADMIN_TOKEN}`)
      return c.json({ error: "unauthorized" }, 401);
    const { guild, channel, operation } = c.req.param();
    if (![guild, channel, operation].every(snowflake))
      return c.json({ error: "invalid_payload" }, 400);
    const value = await status(c.env, "discord", session(guild, channel), operation);
    return value ? c.json(value) : c.json({ error: "not_found" }, 404);
  });
  app.post("/", async (c) => {
    const started = Date.now();
    let guilds: Guild[];
    try {
      guilds = policy(c.env);
    } catch {
      return c.json({ error: "discord_unconfigured" }, 503);
    }
    const ts = c.req.header("x-signature-timestamp") ?? "";
    if (
      !/^\d{10,12}$/.test(ts) ||
      Math.abs(Date.now() / 1000 - Number(ts)) > 300 ||
      !/^[a-fA-F0-9]{128}$/.test(c.req.header("x-signature-ed25519") ?? "")
    )
      return c.json({ error: "invalid_signature" }, 401);
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
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
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid_payload" }, 400);
    }
    // Keep the SDK's real raw-body Ed25519 verification and PING dispatch, not a substitute verifier.
    const discord = new DiscordHono<{ Bindings: AdapterEnv }>().command("ask", async (ctx) => {
      const i = ctx.interaction;
      const guild = guilds.find((g) => g.id === i.guild_id);
      const actor = i.member?.user;
      if (!guild || !actor || actor.bot || !guild.actors.includes(actor.id))
        return c.json({ error: "forbidden" }, 403);
      const options = "options" in i.data ? i.data.options : undefined;
      const prompt =
        options?.length === 1 && options[0]?.type === 3 && options[0].name === "prompt"
          ? options[0].value
          : undefined;
      if (
        !snowflake(i.id) ||
        !snowflake(i.channel_id) ||
        typeof i.token !== "string" ||
        !/^[A-Za-z0-9._-]{1,2048}$/.test(i.token) ||
        typeof prompt !== "string" ||
        !prompt.trim() ||
        prompt.length > 6000
      )
        return c.json({ error: "invalid_payload" }, 400);
      const sessionId = session(guild.id, i.channel_id);
      if (Date.now() - createdAt(i.id) > 2500 && !(await status(c.env, "discord", sessionId, i.id)))
        return c.json({ error: "ack_deadline" }, 503);
      const now = Date.now();
      if (now >= windowEnd) {
        windowEnd = now + 60000;
        ingressCount = 0;
        actors.clear();
      }
      const actorKey = `${guild.id}:${actor.id}`;
      const count = actors.get(actorKey) ?? 0;
      if (count >= 20 || ingressCount >= 100) {
        c.header("Retry-After", String(Math.max(1, Math.ceil((windowEnd - now) / 1000))));
        return c.json({ error: "rate_limited" }, 429);
      }
      const remaining = started + 2500 - now;
      if (remaining <= 0) return c.json({ error: "ack_deadline" }, 503);
      // Reserve synchronously; limits are per isolate, with durable queue bounds behind them.
      ingressCount++;
      actors.set(actorKey, count + 1);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          execute(c.env, {
            adapter: "discord",
            input: { sessionId, operationId: i.id, input: prompt.trim() },
            principal: {
              id: `discord_${guild.id}`,
              sessions: [sessionId],
              resources: guild.resources ?? [],
            },
            reply: {
              application: i.application_id,
              token: i.token,
              expires: createdAt(i.id) + 900000,
            },
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("ack_deadline")), remaining);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (Date.now() >= started + 2500) return c.json({ error: "ack_deadline" }, 503);
      return ctx.resDefer();
    });
    // Application check also covers PING, which has no guild/member fields.
    const parsed = JSON.parse(raw);
    if (parsed?.application_id !== c.env.DISCORD_APPLICATION_ID)
      return c.json({ error: "forbidden_application" }, 403);
    if (parsed.type !== 1 && (parsed.type !== 2 || parsed.data?.name !== "ask"))
      return c.json({ error: "unsupported_interaction" }, 400);
    return discord.fetch(
      new Request(c.req.url, { method: "POST", headers: c.req.raw.headers, body: bytes }),
      c.env,
    );
  });
  return app;
}

export const deliver: DeliveryHandler = async ({ env, job, result, signal }) => {
  const { application, token, expires } = job.reply;
  if (
    application !== env.DISCORD_APPLICATION_ID ||
    !snowflake(application) ||
    typeof token !== "string" ||
    !/^[A-Za-z0-9._-]{1,2048}$/.test(token) ||
    typeof expires !== "number"
  )
    return { status: "failed", code: "invalid_destination" };
  if (Date.now() >= expires) return { status: "failed", code: "interaction_token_expired" };
  const content =
    result.status === "done"
      ? (result.text || "Completed without a text response.").slice(0, 2000)
      : `Agent operation ${result.status}. Check the session for recovery.`;
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${application}/${token}/messages/@original`,
    {
      method: "PATCH",
      redirect: "manual",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    },
  );
  if (response.ok) return { status: "delivered" };
  if (response.status === 404 || response.status === 401)
    return { status: "failed", code: "interaction_token_expired" };
  if (response.status === 429) {
    const delay = Number(response.headers.get("retry-after"));
    if (!Number.isFinite(delay) || delay <= 0)
      return { status: "failed", code: "invalid_retry_after" };
    if (Date.now() + delay * 1000 >= expires)
      return { status: "failed", code: "interaction_token_expired" };
    return { status: "retry", code: "discord_rate_limited", retryAfterMs: delay * 1000 };
  }
  return { status: response.status >= 500 ? "retry" : "failed", code: "discord_http_error" };
};
