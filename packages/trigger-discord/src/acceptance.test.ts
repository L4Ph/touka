import { vi, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { create } from "./index";
import { remainingAckBudget } from "./ack-budget";
import type { TriggerDependencies } from "@remote-agent/trigger-contract";

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
    (await post({ ...interaction(), guild_id: undefined, member: undefined, user: { id: actor } }))
      .status,
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
