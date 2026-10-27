import { Hono } from "hono";
import type {
  AdapterAppEnv,
  AdapterDependencies,
  AdapterEnv,
  DeliveryHandler,
} from "@remote-agent/adapter-contract";

const login = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const validOperation = (v: string) => /^[A-Za-z0-9_-]{1,128}$/.test(v);
function policy(env: AdapterEnv) {
  const actors: unknown = JSON.parse(env.GITHUB_ACTORS ?? "null");
  if (
    !env.GITHUB_WEBHOOK_SECRET ||
    !login(env.GITHUB_BOT_LOGIN) ||
    !Array.isArray(actors) ||
    !actors.length ||
    actors.length > 1000 ||
    !actors.every(login)
  )
    throw new Error("github_unconfigured");
  return { actors: actors.map((actor: string) => actor.toLowerCase()), bot: env.GITHUB_BOT_LOGIN };
}
async function sessionId(repo: string, number: number) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${repo}#${number}`));
  return `github_${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function create({
  execute,
  authenticate,
  status,
  github,
}: AdapterDependencies): Hono<AdapterAppEnv> {
  const app = new Hono<AdapterAppEnv>();
  // shortcut: quota is per app/isolate and resets on eviction; use shared storage for a fleet-wide quota.
  let windowEnd = 0;
  let ingressCount = 0;
  const actorCounts = new Map<string, number>();
  app.get("/jobs/:owner/:repo/:number/:operation", authenticate, async (c) => {
    const { owner, repo, number, operation } = c.req.param();
    if (!/^[1-9]\d{0,14}$/.test(number) || !positive(Number(number)) || !validOperation(operation))
      return c.json({ error: "invalid_payload" }, 400);
    const session = await sessionId(`${owner}/${repo}`, Number(number));
    const principal = c.get("principal");
    if (!principal.sessions.includes(session)) return c.json({ error: "forbidden" }, 403);
    const job = await status(c.env, "github", session, operation);
    return job ? c.json(job) : c.json({ error: "not_found" }, 404);
  });
  app.post("/", async (c) => {
    let configured: ReturnType<typeof policy>;
    try {
      configured = policy(c.env);
    } catch {
      return c.json({ error: "github_unconfigured" }, 503);
    }
    const signature = c.req.header("x-hub-signature-256") ?? "";
    if (!/^sha256=[a-f0-9]{64}$/.test(signature))
      return c.json({ error: "invalid_signature" }, 401);
    const reader = c.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader)
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 32768) {
          await reader.cancel();
          return c.json({ error: "payload_too_large" }, 413);
        }
        chunks.push(value);
      }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(c.env.GITHUB_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const digest = Uint8Array.from(signature.slice(7).match(/../g)!, (byte) => parseInt(byte, 16));
    if (!(await crypto.subtle.verify("HMAC", key, digest, bytes)))
      return c.json({ error: "invalid_signature" }, 401);
    let data: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid_payload");
      data = record(value);
    } catch {
      return c.json({ error: "invalid_payload" }, 400);
    }
    const event = c.req.header("x-github-event");
    if (!["issue_comment", "pull_request_review_comment"].includes(event ?? ""))
      return c.json({ ignored: true });
    if (typeof data.action !== "string") return c.json({ error: "invalid_payload" }, 400);
    if (data.action !== "created") return c.json({ ignored: true });
    const comment = record(data.comment);
    const sender = record(data.sender);
    const user = record(comment.user);
    if (
      !login(sender.login) ||
      !login(user.login) ||
      !positive(sender.id) ||
      sender.id !== user.id ||
      sender.login.toLowerCase() !== user.login.toLowerCase() ||
      !["User", "Bot"].includes(String(sender.type)) ||
      !["User", "Bot"].includes(String(user.type))
    )
      return c.json({ error: "invalid_payload" }, 400);
    if (
      sender.type === "Bot" ||
      user.type === "Bot" ||
      sender.login.toLowerCase() === configured.bot.toLowerCase()
    )
      return c.json({ ignored: true });
    if (!configured.actors.includes(sender.login.toLowerCase()))
      return c.json({ error: "forbidden" }, 403);
    const repo = record(data.repository).full_name;
    if (typeof repo !== "string") return c.json({ error: "invalid_payload" }, 400);
    try {
      if (github(c.env).installation(repo) !== record(data.installation).id)
        return c.json({ error: "forbidden" }, 403);
    } catch {
      return c.json({ error: "repository_forbidden" }, 403);
    }
    const number = record(event === "issue_comment" ? data.issue : data.pull_request).number;
    const operation = c.req.header("x-github-delivery") ?? "";
    if (
      !positive(number) ||
      !positive(comment.id) ||
      !validOperation(operation) ||
      (comment.in_reply_to_id !== undefined && !positive(comment.in_reply_to_id)) ||
      typeof comment.body !== "string" ||
      comment.body.length > 16000
    )
      return c.json({ error: "invalid_payload" }, 400);
    const escaped = configured.bot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const mention = new RegExp(`(^|[^A-Za-z0-9_@-])@${escaped}(?![A-Za-z0-9_\\[\\]-])`, "gi");
    if (!mention.test(comment.body)) return c.json({ ignored: true });
    const input = comment.body.replace(mention, "$1").replace(/\r\n?/g, "\n").trim();
    if (!input) return c.json({ ignored: true });
    const now = Date.now();
    if (now >= windowEnd) {
      windowEnd = now + 60000;
      ingressCount = 0;
      actorCounts.clear();
    }
    const actor = sender.login.toLowerCase();
    const actorCount = actorCounts.get(actor) ?? 0;
    if (actorCount >= 20 || ingressCount >= 100) {
      c.header("Retry-After", String(Math.max(1, Math.ceil((windowEnd - now) / 1000))));
      return c.json({ error: "rate_limited", retryable: true }, 429);
    }
    // Reserve synchronously before any await, including session hashing and durable acceptance.
    ingressCount++;
    actorCounts.set(actor, actorCount + 1);
    const session = await sessionId(repo, number);
    try {
      const receipt = await execute(c.env, {
        adapter: "github",
        input: { sessionId: session, operationId: operation, input },
        principal: { id: session, sessions: [session], resources: [`github:${repo}:read`] },
        reply: {
          repo,
          number,
          ...(event === "pull_request_review_comment"
            ? { reviewComment: comment.in_reply_to_id ?? comment.id }
            : {}),
        },
      });
      return c.json(receipt, 202);
    } catch (error) {
      const conflict =
        error instanceof Error &&
        ["delivery_conflict", "delivery_identity_conflict"].includes(error.message);
      return c.json(
        { error: conflict ? "delivery_conflict" : "delivery_unavailable" },
        conflict ? 409 : 503,
      );
    }
  });
  return app;
}

function retryDelay(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value !== null) {
    const ms = /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value) * 1000
      : Date.parse(value) - Date.now();
    if (Number.isFinite(ms)) return Math.min(3600000, Math.max(0, ms));
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (reset > 0) return Math.min(3600000, Math.max(0, reset * 1000 - Date.now()));
  return undefined;
}
export const deliver: DeliveryHandler = async ({ job, result, signal, github }) => {
  const { repo, number, reviewComment } = job.reply;
  if (
    typeof repo !== "string" ||
    !positive(number) ||
    (reviewComment !== undefined && !positive(reviewComment))
  )
    return { status: "failed", code: "invalid_destination" };
  try {
    github.installation(repo);
  } catch {
    return { status: "failed", code: "repository_forbidden" };
  }
  let token: string;
  try {
    token = await github.token(repo, "reply");
  } catch (error) {
    const status = record(error).status;
    if (
      status === 429 ||
      (status === 403 && record(error).retryAfter !== undefined) ||
      (typeof status === "number" && status >= 500) ||
      (error instanceof Error && error.message === "github_transport_failed")
    )
      return {
        status: "retry",
        code: "github_auth_unavailable",
        retryAfterMs: retryDelay(
          new Headers({ "retry-after": String(record(error).retryAfter ?? "") }),
        ),
      };
    return { status: "failed", code: "github_auth_failed" };
  }
  const text =
    result.status === "done"
      ? result.text || "Completed without a text response."
      : `Agent operation ${result.status}. Check the session for recovery.`;
  // Bound UTF-8 bytes, not just JS characters; GitHub limits comment bodies to 65536 bytes.
  let body = "";
  let size = 0;
  for (const char of text) {
    size += new TextEncoder().encode(char).length;
    if (size > 60000) {
      body += "\n\n[Response truncated; see the session.]";
      break;
    }
    body += char;
  }
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${repo}/${
        reviewComment === undefined ? `issues/${number}/comments` : `pulls/${number}/comments`
      }`,
      {
        method: "POST",
        redirect: "manual",
        signal,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "remote-agent",
        },
        body: JSON.stringify({
          body,
          ...(reviewComment === undefined ? {} : { in_reply_to: reviewComment }),
        }),
      },
    );
  } catch {
    return { status: "retry", code: "github_transport_failed" };
  }
  await response.body?.cancel();
  if (response.status === 201) return { status: "delivered" };
  if (response.status === 401) {
    github.invalidate(repo, "reply");
    return { status: "failed", code: "github_unauthorized" };
  }
  if (
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"))
  )
    return {
      status: "retry",
      code: "github_rate_or_server_error",
      retryAfterMs: retryDelay(response.headers),
    };
  return { status: "failed", code: "github_reply_rejected" };
};
