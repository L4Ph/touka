import type nodeAssert from "node:assert/strict";
export type SendResult =
  | { status: "delivered" }
  | { status: "retry" | "failed"; code: string; retryAfterMs?: number };
const snowflake = (v: unknown): v is string => typeof v === "string" && /^[0-9]{17,20}$/.test(v);
export async function editInteractionResponse(
  env: { DISCORD_APPLICATION_ID?: string },
  destination: Record<string, unknown>,
  content: string,
  signal: AbortSignal,
): Promise<SendResult> {
  const { application, token, expires } = destination;
  if (
    application !== env.DISCORD_APPLICATION_ID ||
    !snowflake(application) ||
    typeof token !== "string" ||
    !/^[A-Za-z0-9._-]{1,2048}$/.test(token) ||
    typeof expires !== "number"
  )
    return { status: "failed", code: "invalid_destination" };
  if (Date.now() >= expires) return { status: "failed", code: "interaction_token_expired" };
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
}

if (import.meta.vitest) {
  const { vi, test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;

  const deliver = (c: {
    env: { DISCORD_APPLICATION_ID: string };
    job: { reply: Record<string, unknown> };
    result: { text: string };
    signal: AbortSignal;
  }) => editInteractionResponse(c.env, c.job.reply, c.result.text, c.signal);

  test("expired tokens and rate limits crossing expiry terminate without fallback or secret disclosure", async (t) => {
    const now = 1800000000000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let retryAfter = "4";
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(null, { status: 429, headers: { "retry-after": retryAfter } }),
      );
    const context = {
      env: { DISCORD_APPLICATION_ID: "111111111111111111" },
      job: {
        trigger: "discord",
        input: { sessionId: "s", operationId: "o", input: "task" },
        principal: { id: "p", sessions: ["s"], resources: [] },
        reply: {
          application: "111111111111111111",
          token: "secret-token",
          expires: Date.now() - 1,
        },
      },
      result: { sessionId: "s", operationId: "o", status: "done", text: "answer" },
      signal: new AbortController().signal,
    };
    assert.deepEqual(await deliver(context), {
      status: "failed",
      code: "interaction_token_expired",
    });
    assert.deepEqual(
      await deliver({
        ...context,
        job: { ...context.job, reply: { ...context.job.reply, application: "222222222222222222" } },
      }),
      { status: "failed", code: "invalid_destination" },
    );
    assert.equal(network.mock.calls.length, 0);
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
      network.mock.calls.length,
      3,
      "each attempt only edits the original response; no bot fallback",
    );
  });
}
