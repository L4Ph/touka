import type nodeAssert from "node:assert/strict";
import type { TriggerDependencies } from "@remote-agent/trigger-contract";
import { editInteractionResponse } from "@remote-agent/connector-discord";
import { Hono } from "hono";
import { DiscordHono } from "discord-hono";
import { remainingAckBudget } from "./ack-budget";
import type { TriggerAppEnv, TriggerEnv, DeliveryHandler } from "@remote-agent/trigger-contract";

const snowflake = (v: unknown): v is string => typeof v === "string" && /^[0-9]{17,20}$/.test(v);
type Guild = { id: string; actors: string[]; resources?: string[] };
function policy(env: TriggerEnv): Guild[] {
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

export function create({ execute, status }: TriggerDependencies): Hono<TriggerAppEnv> {
  const app = new Hono<TriggerAppEnv>();
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
    const handle = async () => {
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
      const discord = new DiscordHono<{ Bindings: TriggerEnv }>().command("ask", async (ctx) => {
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
        const originalDeadline = createdAt(i.id) + 2500;
        const duplicate = Date.now() >= originalDeadline;
        if (duplicate && !(await status(c.env, "discord", sessionId, i.id)))
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
        const remaining = remainingAckBudget(started, originalDeadline, duplicate, now);
        if (remaining <= 0) return c.json({ error: "ack_deadline" }, 503);
        // Reserve synchronously; limits are per isolate, with durable queue bounds behind them.
        ingressCount++;
        actors.set(actorKey, count + 1);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            execute(c.env, {
              trigger: "discord",
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
        if (remainingAckBudget(started, originalDeadline, duplicate, Date.now()) <= 0)
          return c.json({ error: "ack_deadline" }, 503);
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
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bounds body reading, signature verification and duplicate RPCs too; RPCs are not cancelled.
      return await Promise.race([
        handle(),
        new Promise<Response>((resolve) => {
          timer = setTimeout(
            () => resolve(c.json({ error: "discord_unavailable" }, 503)),
            Math.max(0, started + 2500 - Date.now()),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
  return app;
}

export const deliver: DeliveryHandler = async ({ env, job, result, signal }) => {
  const content =
    result.status === "done"
      ? (result.text || "Completed without a text response.").slice(0, 2000)
      : `Agent operation ${result.status}. Check the session for recovery.`;
  return editInteractionResponse(env, job.reply, content, signal);
};

if (import.meta.vitest) {
  const { vi, test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { generateKeyPairSync, sign } = await import("node:crypto");
  const { remainingAckBudget } = await import("./ack-budget");

  const application = "111111111111111111";
  const guild = "222222222222222222";
  const actor = "444444444444444444";
  const keys = generateKeyPairSync("ed25519");
  const env = {
    DISCORD_APPLICATION_ID: application,
    DISCORD_PUBLIC_KEY: keys.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex"),
    DISCORD_ADMIN_TOKEN: "admin",
    DISCORD_GUILDS: JSON.stringify([{ id: guild, actors: [actor] }]),
  };
  const unexpected = () => {
    throw new Error("Rejected request reached durable execution");
  };
  const dependencies: TriggerDependencies = {
    authenticate: unexpected,
    submit: unexpected,
    status: unexpected,
    execute: unexpected,
  };
  function interaction() {
    return {
      type: 2,
      id: ((BigInt(Date.now()) - 1420070400000n) << 22n).toString(),
      application_id: application,
      guild_id: guild,
      channel_id: "333333333333333333",
      member: { user: { id: actor } },
      token: "private-token",
      data: { name: "ask", type: 1, options: [{ name: "prompt", type: 3, value: "Task" }] },
    };
  }

  test("ACK time uses the original interaction budget and rechecks it after acceptance", () => {
    const started = 2000;
    const originalDeadline = 3000;
    assert.equal(remainingAckBudget(started, originalDeadline, false, started), 1000);
    assert.equal(remainingAckBudget(started, originalDeadline, false, started + 1500), -500);
    assert.equal(remainingAckBudget(started, originalDeadline, false, originalDeadline), 0);
    assert.equal(remainingAckBudget(started, 10000, false, started), 2500);
    assert.equal(remainingAckBudget(started, originalDeadline, true, started + 1500), 1000);
    assert.equal(remainingAckBudget(started, originalDeadline, true, started + 2500), 0);
  });

  test("the pre-ACK budget includes a stalled request body", async (t) => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    t.onTestFinished(() => {
      vi.useRealTimers();
    });
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull() {
        entered();
      },
    });
    const init = {
      method: "POST",
      headers: {
        "x-signature-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-signature-ed25519": "0".repeat(128),
      },
      body,
      duplex: "half",
    };
    try {
      const pending = create(dependencies).request("https://trigger/", init, env);
      await reading;
      vi.advanceTimersByTime(2500);
      const response = await pending;
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "discord_unavailable" });
    } finally {
      controller.close();
    }
  });

  test("real discord-hono verification and ingress guards reject before durable execution", async () => {
    const app = create(dependencies);
    const post = (
      body: unknown,
      settings: { timestamp?: string; corrupt?: boolean; raw?: string } = {},
      bindings = env,
    ) => {
      const raw = settings.raw ?? JSON.stringify(body);
      const timestamp = settings.timestamp ?? String(Math.floor(Date.now() / 1000));
      return app.request(
        "https://trigger/",
        {
          method: "POST",
          headers: {
            "x-signature-timestamp": timestamp,
            "x-signature-ed25519": settings.corrupt
              ? "0".repeat(128)
              : sign(null, Buffer.from(timestamp + raw), keys.privateKey).toString("hex"),
          },
          body: raw,
        },
        bindings,
      );
    };
    const ping = await post({ type: 1, application_id: application });
    assert.equal(ping.status, 200);
    assert.deepEqual(await ping.json(), { type: 1 });
    assert.equal(
      (await post({ type: 1, application_id: application }, { corrupt: true })).status,
      401,
    );
    for (const delta of [-301, 301]) {
      assert.equal(
        (await post(interaction(), { timestamp: String(Math.floor(Date.now() / 1000) + delta) }))
          .status,
        401,
      );
    }
    assert.equal((await post({}, { raw: "x".repeat(32769) })).status, 413);
    assert.equal((await post({}, { raw: "{" })).status, 400);
    assert.equal((await post({ ...interaction(), application_id: actor })).status, 403);
    assert.equal((await post({ ...interaction(), guild_id: actor })).status, 403);
    assert.equal((await post({ ...interaction(), member: { user: { id: guild } } })).status, 403);
    assert.equal(
      (
        await post({
          ...interaction(),
          guild_id: undefined,
          member: undefined,
          user: { id: actor },
        })
      ).status,
      403,
    );
    assert.equal(
      (await post({ ...interaction(), member: { user: { id: actor, bot: true } } })).status,
      403,
    );
    assert.equal(
      (
        await post({
          ...interaction(),
          data: {
            name: "ask",
            type: 1,
            options: [{ name: "prompt", type: 3, value: "x".repeat(6001) }],
          },
        })
      ).status,
      400,
    );
    assert.equal((await post(interaction(), {}, { ...env, DISCORD_GUILDS: "[]" })).status, 503);
    assert.equal((await post({ ...interaction(), type: 3 })).status, 400);
  });
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { spawnSync } = await import("node:child_process");

  test("offline registration emits a guild-scoped ask command with required bounded prompt and disabled default permissions", () => {
    const result = spawnSync(
      process.execPath,
      [new URL("../scripts/register.mjs", import.meta.url).pathname],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISCORD_APPLICATION_ID: "111111111111111111",
          DISCORD_REGISTER_GUILD: "222222222222222222",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const registration = JSON.parse(result.stdout);
    assert.equal(
      registration.url,
      "https://discord.com/api/v10/applications/111111111111111111/guilds/222222222222222222/commands",
    );
    assert.equal(registration.method, "POST");
    assert.deepEqual(registration.body, {
      name: "ask",
      description: "Ask the team agent",
      type: 1,
      default_member_permissions: "0",
      options: [
        {
          name: "prompt",
          description: "Task for the agent",
          type: 3,
          required: true,
          max_length: 6000,
        },
      ],
    });
    const invalid = spawnSync(
      process.execPath,
      [new URL("../scripts/register.mjs", import.meta.url).pathname],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DISCORD_APPLICATION_ID: "invalid",
          DISCORD_REGISTER_GUILD: "222222222222222222",
        },
      },
    );
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, "");
  });
}
