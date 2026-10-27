import { test } from "node:test";
import assert from "node:assert/strict";
import { editInteractionResponse } from "./index";
const deliver = (c: {
  env: { DISCORD_APPLICATION_ID: string };
  job: { reply: Record<string, unknown> };
  result: { text: string };
  signal: AbortSignal;
}) => editInteractionResponse(c.env, c.job.reply, c.result.text, c.signal);

test("expired tokens and rate limits crossing expiry terminate without fallback or secret disclosure", async (t) => {
  const now = 1800000000000;
  t.mock.method(Date, "now", () => now);
  let retryAfter = "4";
  const network = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 429, headers: { "retry-after": retryAfter } }),
  );
  const context = {
    env: { DISCORD_APPLICATION_ID: "111111111111111111" },
    job: {
      trigger: "discord",
      input: { sessionId: "s", operationId: "o", input: "task" },
      principal: { id: "p", sessions: ["s"], resources: [] },
      reply: { application: "111111111111111111", token: "secret-token", expires: Date.now() - 1 },
    },
    result: { sessionId: "s", operationId: "o", status: "done", text: "answer" },
    signal: new AbortController().signal,
  };
  assert.deepEqual(await deliver(context), { status: "failed", code: "interaction_token_expired" });
  assert.deepEqual(
    await deliver({
      ...context,
      job: { ...context.job, reply: { ...context.job.reply, application: "222222222222222222" } },
    }),
    { status: "failed", code: "invalid_destination" },
  );
  assert.equal(network.mock.callCount(), 0);
  const live = {
    ...context,
    job: { ...context.job, reply: { ...context.job.reply, expires: now + 4000 } },
  };
  for (const delay of ["4", "5"]) {
    retryAfter = delay;
    assert.deepEqual(
      await deliver(live),
      {
        status: "failed",
        code: "interaction_token_expired",
      },
      "Retry-After reaching or crossing expiration must be terminal",
    );
  }
  retryAfter = "3";
  assert.deepEqual(await deliver(live), {
    status: "retry",
    code: "discord_rate_limited",
    retryAfterMs: 3000,
  });
  assert.equal(
    network.mock.callCount(),
    3,
    "each attempt only edits the original response; no bot fallback",
  );
});
