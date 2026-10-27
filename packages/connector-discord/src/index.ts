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
