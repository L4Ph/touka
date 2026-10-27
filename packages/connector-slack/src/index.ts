import { SlackAPIClient, SlackAPIConnectionError } from "slack-web-api-client";
export interface SlackEnv {
  SLACK_WORKSPACES?: string;
}
type Workspace = {
  id: string;
  actors: string[];
  botUserId: string;
  token: string;
  resources?: string[];
};
const id = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
function workspaces(env: SlackEnv): Workspace[] {
  const value: unknown = JSON.parse(env.SLACK_WORKSPACES ?? "null");
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 100 ||
    !value.every(
      (w) =>
        id(w?.id) &&
        id(w?.botUserId) &&
        typeof w?.token === "string" &&
        w.token.length > 0 &&
        Array.isArray(w.actors) &&
        w.actors.length > 0 &&
        w.actors.length <= 1000 &&
        w.actors.every(id) &&
        (w.resources === undefined ||
          (Array.isArray(w.resources) &&
            w.resources.length <= 100 &&
            w.resources.every((r: unknown) => typeof r === "string" && r.length <= 256))),
    )
  )
    throw new Error("slack_unconfigured");
  return value;
}

export function slackPolicies(env: SlackEnv) {
  return workspaces(env).map(({ token: _token, ...policy }) => policy);
}
export async function postMessage(
  env: SlackEnv,
  team: string,
  channel: string,
  thread: string,
  text: string,
) {
  const workspace = workspaces(env).find((w) => w.id === team);
  if (!workspace) return { status: "failed" as const, code: "workspace_removed" };
  if (!id(channel) || !/^\d{1,16}\.\d{1,6}$/.test(thread) || text.length > 3900)
    return { status: "failed" as const, code: "invalid_destination" };
  // Durable outbox, not the SDK's in-memory retries, owns Retry-After and recovery.
  const client = new SlackAPIClient(workspace.token, {
    retryHandlers: [],
    throwSlackAPIError: false,
    logLevel: "ERROR",
  });
  try {
    const data = await client.chat.postMessage({
      channel,
      thread_ts: thread,
      text,
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (data.ok) return { status: "delivered" as const };
    return {
      status: [
        "invalid_auth",
        "token_revoked",
        "channel_not_found",
        "not_in_channel",
        "missing_scope",
      ].includes(data.error ?? "")
        ? ("failed" as const)
        : ("retry" as const),
      code: "slack_api_error",
    };
  } catch (error) {
    if (error instanceof SlackAPIConnectionError) {
      if (error.status === 429)
        return {
          status: "retry" as const,
          code: "rate_limited",
          retryAfterMs: Number(error.headers?.get("retry-after")) * 1000,
        };
      return {
        status:
          error.status >= 500 || error.status === -1 ? ("retry" as const) : ("failed" as const),
        code: "slack_http_error",
      };
    }
    return { status: "retry" as const, code: "slack_http_error" };
  }
}
