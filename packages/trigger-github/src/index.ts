import type nodeAssert from "node:assert/strict";
import type { TriggerDependencies, TriggerExecution } from "@remote-agent/trigger-contract";
import { githubConnector } from "@remote-agent/connector-github";
import { Hono } from "hono";
import type { TriggerAppEnv, TriggerEnv, DeliveryHandler } from "@remote-agent/trigger-contract";

const login = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9-]{1,39}(?:\[bot\])?$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const validOperation = (v: string) => /^[A-Za-z0-9_-]{1,128}$/.test(v);
function policy(env: TriggerEnv) {
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
  // People mention an App as `@slug`, while its own comments carry the login `slug[bot]`; accept both.
  const bot = env.GITHUB_BOT_LOGIN.replace(/\[bot\]$/, "");
  return {
    actors: actors.map((actor: string) => actor.toLowerCase()),
    bot,
    botLogin: `${bot}[bot]`,
  };
}
/** A best-effort step may delay a response, never hold it: GitHub gives a webhook ten seconds. */
async function within(ms: number, step: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([step, new Promise((resolve) => (timer = setTimeout(resolve, ms)))]);
  clearTimeout(timer);
}
const reactionTarget = (event: string | undefined, id: number) => ({
  kind:
    event === "pull_request_review_comment"
      ? ("review-comment" as const)
      : ("issue-comment" as const),
  id,
});
async function sessionId(repo: string, number: number) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${repo}#${number}`));
  return `github_${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function create({
  execute,
  authenticate,
  status,
}: TriggerDependencies): Hono<TriggerAppEnv> {
  const app = new Hono<TriggerAppEnv>();
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
      [configured.bot, configured.botLogin]
        .map((own) => own.toLowerCase())
        .includes(sender.login.toLowerCase())
    )
      return c.json({ ignored: true });
    if (!configured.actors.includes(sender.login.toLowerCase()))
      return c.json({ error: "forbidden" }, 403);
    const repo = record(data.repository).full_name;
    if (typeof repo !== "string") return c.json({ error: "invalid_payload" }, 400);
    try {
      if (githubConnector(c.env).auth.installation(repo) !== record(data.installation).id)
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
    // `@slug` or `@slug[bot]`, not followed by more login characters (so `@slug-other` is someone else).
    const mention = new RegExp(
      `(^|[^A-Za-z0-9_@-])@${escaped}(?:\\[bot\\](?![A-Za-z0-9_-])|(?![A-Za-z0-9_\\[-]))`,
      "gi",
    );
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
    const target = reactionTarget(event, comment.id);
    const connector = githubConnector(c.env);
    try {
      const receipt = await execute(c.env, {
        trigger: "github",
        input: { sessionId: session, operationId: operation, input },
        // Allowlisted actors on configured repositories may use the bot's write tools; it never merges.
        principal: {
          id: session,
          sessions: [session],
          // `github-thread:` tells the tools which issue or pull request this conversation is about,
          // without putting the repository or number into the prompt.
          resources: [
            `github:${repo}:read`,
            `github:${repo}:write`,
            `github-thread:${repo}#${number}`,
          ],
        },
        reply: {
          repo,
          number,
          ...(event === "pull_request_review_comment"
            ? { reviewComment: comment.in_reply_to_id ?? comment.id }
            : {}),
          // The comment that started this, so the status emoji can go on it.
          commentId: target.id,
          commentKind: target.kind,
        },
      });
      // Only for new work: a redelivery after the reply must not put 👀 back next to 🚀.
      if (receipt.accepted)
        await within(3000, connector.react(repo, target, { add: ["eyes"] }, configured.botLogin));
      return c.json(receipt, 202);
    } catch (error) {
      // A refusal that retrying cannot fix (for example permissions that changed after the
      // conversation began): mark it, and answer 200 so GitHub does not redeliver it forever.
      if (
        error instanceof Error &&
        ["execution_grant_conflict", "execution_forbidden"].includes(error.message)
      ) {
        await within(
          3000,
          connector.react(repo, target, { add: ["confused"] }, configured.botLogin),
        );
        return c.json({ ignored: true, reason: error.message });
      }
      const conflict = error instanceof Error && error.message === "delivery_conflict";
      return c.json(
        { error: conflict ? "delivery_conflict" : "delivery_unavailable" },
        conflict ? 409 : 503,
      );
    }
  });
  return app;
}

export const deliver: DeliveryHandler = async ({ env, job, result, signal }) => {
  const { repo, number, reviewComment } = job.reply;
  if (
    typeof repo !== "string" ||
    !positive(number) ||
    (reviewComment !== undefined && !positive(reviewComment))
  )
    return { status: "failed", code: "invalid_destination" };
  const text =
    result.status === "done"
      ? result.text || "Completed without a text response."
      : `Agent operation ${result.status}. Check the session for recovery.`;
  const connector = githubConnector(env);
  const sent = await connector.reply(
    repo,
    number as number,
    reviewComment as number | undefined,
    text,
    signal,
  );
  // The 👀 set on acceptance becomes 🚀 (answered) or 😕 (not answered, or the reply was refused).
  // Why not policy(env): this runs after the reply is out, and nothing here may throw or run long
  // enough to make the delivery attempt fail and post the reply a second time.
  const { commentId, commentKind } = job.reply;
  const bot = env.GITHUB_BOT_LOGIN?.replace(/\[bot\]$/, "");
  if (
    sent.status !== "retry" &&
    bot &&
    positive(commentId) &&
    (commentKind === "issue-comment" || commentKind === "review-comment")
  )
    await within(
      3000,
      connector.react(
        repo,
        { kind: commentKind, id: commentId },
        {
          remove: ["eyes"],
          add: [sent.status === "delivered" && result.status === "done" ? "rocket" : "confused"],
        },
        `${bot}[bot]`,
      ),
    );
  return sent;
};

if (import.meta.vitest) {
  const { test, vi } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { createHmac, generateKeyPairSync } = await import("node:crypto");

  const secret = "reactions-webhook-secret";
  const env = {
    GITHUB_WEBHOOK_SECRET: secret,
    GITHUB_BOT_LOGIN: "touka-ai",
    GITHUB_ACTORS: '["alice"]',
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    GITHUB_REPOSITORIES: '{"team/*":456}',
  };

  /** A fake GitHub that records the reaction calls the trigger makes. */
  function github() {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens"))
        return Response.json(
          { token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
          { status: 201 },
        );
      const key = `${init?.method ?? "GET"} ${url.pathname}${url.search}`;
      const content = init?.body ? JSON.parse(String(init.body)).content : undefined;
      calls.push(content ? `${key} ${content}` : key);
      if (key.startsWith("GET") && key.includes("/reactions"))
        return Response.json([{ id: 3, user: { login: "touka-ai[bot]" } }]);
      if (key.startsWith("DELETE")) return new Response(null, { status: 204 });
      return Response.json({ id: 1 }, { status: 201 });
    });
    return calls;
  }

  function webhook(
    event = "issue_comment",
    comment: Record<string, unknown> = {},
    { accepted = true, refuse = "" } = {},
  ) {
    const executed: TriggerExecution[] = [];
    const deps: TriggerDependencies = {
      authenticate: async (_c, next) => next(),
      submit: async () => null,
      execute: async (_env, request) => {
        if (refuse) throw new Error(refuse);
        executed.push(request);
        return { accepted, operationId: request.input.operationId };
      },
      status: async () => null,
    };
    const app = create(deps);
    const send = async (delivery = "d1") => {
      const raw = JSON.stringify({
        action: "created",
        repository: { full_name: "team/project" },
        installation: { id: 456 },
        sender: { id: 42, login: "alice", type: "User" },
        ...(event === "issue_comment" ? { issue: { number: 7 } } : { pull_request: { number: 7 } }),
        comment: {
          id: 90,
          body: "@touka-ai look",
          user: { id: 42, login: "alice", type: "User" },
          ...comment,
        },
      });
      const response = await app.request(
        "/",
        {
          method: "POST",
          body: raw,
          headers: {
            "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
            "x-github-delivery": delivery,
            "x-github-event": event,
          },
        },
        env,
      );
      return { status: response.status, body: await response.json() };
    };
    return { send, executed };
  }

  test("an accepted issue comment gets 👀 and its record keeps the comment for the finishing emoji", async () => {
    const calls = github();
    const { send, executed } = webhook();
    assert.equal((await send()).status, 202);
    assert.deepEqual(calls, ["POST /repos/team/project/issues/comments/90/reactions eyes"]);
    assert.equal(executed[0].reply.commentId, 90);
    assert.equal(executed[0].reply.commentKind, "issue-comment");
  });

  test("a review comment is reacted to under pulls/, and replies go to its thread", async () => {
    const calls = github();
    const { send, executed } = webhook("pull_request_review_comment", {
      id: 91,
      in_reply_to_id: 80,
    });
    assert.equal((await send()).status, 202);
    assert.deepEqual(calls, ["POST /repos/team/project/pulls/comments/91/reactions eyes"]);
    assert.equal(executed[0].reply.reviewComment, 80);
    assert.equal(executed[0].reply.commentKind, "review-comment");
  });

  test("delivering a reply swaps 👀 for 🚀, or 😕 when the operation did not answer", async () => {
    const calls = github();
    const job = {
      trigger: "github",
      input: { sessionId: "s", operationId: "o", input: "x" },
      principal: { id: "p", sessions: ["s"], resources: [] },
      reply: { repo: "team/project", number: 7, commentId: 90, commentKind: "issue-comment" },
    };
    const signal = new AbortController().signal;
    const done = { sessionId: "s", operationId: "o", status: "done" as const, text: "hi" };
    assert.deepEqual(await deliver({ env, job, result: done, signal }), { status: "delivered" });
    assert.deepEqual(calls, [
      "POST /repos/team/project/issues/7/comments",
      "GET /repos/team/project/issues/comments/90/reactions?content=eyes&per_page=100",
      "DELETE /repos/team/project/issues/comments/90/reactions/3",
      "POST /repos/team/project/issues/comments/90/reactions rocket",
    ]);
    calls.length = 0;
    await deliver({ env, job, result: { ...done, status: "unanswered" }, signal });
    assert.equal(calls.at(-1), "POST /repos/team/project/issues/comments/90/reactions confused");
  });

  test("a record from before reactions existed still delivers, without any emoji call", async () => {
    const calls = github();
    const job = {
      trigger: "github",
      input: { sessionId: "s", operationId: "o", input: "x" },
      principal: { id: "p", sessions: ["s"], resources: [] },
      reply: { repo: "team/project", number: 7 },
    };
    await deliver({
      env,
      job,
      result: { sessionId: "s", operationId: "o", status: "done", text: "hi" },
      signal: new AbortController().signal,
    });
    assert.deepEqual(calls, ["POST /repos/team/project/issues/7/comments"]);
  });

  test("a redelivered webhook does not put 👀 back next to the answer", async () => {
    const calls = github();
    const { send } = webhook("issue_comment", {}, { accepted: false });
    assert.equal((await send()).status, 202);
    assert.deepEqual(calls, []);
  });

  test("a refusal retrying cannot fix is marked 😕 and answered 200, so GitHub does not redeliver it", async () => {
    const calls = github();
    const { send, executed } = webhook("issue_comment", {}, { refuse: "execution_grant_conflict" });
    const result = await send();
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ignored: true, reason: "execution_grant_conflict" });
    assert.deepEqual(calls, ["POST /repos/team/project/issues/comments/90/reactions confused"]);
    assert.equal(executed.length, 0);
    // Anything else stays a retryable failure.
    const other = webhook("issue_comment", {}, { refuse: "boom" });
    assert.equal((await other.send("d2")).status, 503);
  });

  test("a reply GitHub refuses for good ends 😕 too, and an emoji problem never fails a delivered reply", async () => {
    const calls = github();
    const job = {
      trigger: "github",
      input: { sessionId: "s", operationId: "o", input: "x" },
      principal: { id: "p", sessions: ["s"], resources: [] },
      reply: { repo: "team/project", number: 7, commentId: 90, commentKind: "issue-comment" },
    };
    const result = { sessionId: "s", operationId: "o", status: "done" as const, text: "hi" };
    const signal = new AbortController().signal;
    // GitHub rejects the comment itself (422): a permanent failure, not a retry.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens"))
        return Response.json(
          { token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
          { status: 201 },
        );
      const content = init?.body ? JSON.parse(String(init.body)).content : undefined;
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${content ? ` ${content}` : ""}`);
      if (url.pathname.endsWith("/issues/7/comments")) return new Response("{}", { status: 422 });
      return Response.json([]);
    });
    calls.length = 0;
    assert.equal((await deliver({ env, job, result, signal })).status, "failed");
    assert.equal(calls.at(-1), "POST /repos/team/project/issues/comments/90/reactions confused");
    // The environment of a delivery may lack the webhook settings: the reply still goes out once.
    calls.length = 0;
    const bare = {
      GITHUB_APP_ID: env.GITHUB_APP_ID,
      GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY,
      GITHUB_REPOSITORIES: env.GITHUB_REPOSITORIES,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      new URL(String(input)).pathname.endsWith("/access_tokens")
        ? Response.json(
            { token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
            { status: 201 },
          )
        : Response.json({ id: 1 }, { status: 201 }),
    );
    assert.deepEqual(await deliver({ env: bare, job, result, signal }), { status: "delivered" });
  });
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { Hono } = await import("hono");
  const { createHmac, generateKeyPairSync } = await import("node:crypto");

  const secret = "local-github-webhook-secret";
  function payload(overrides: Record<string, unknown> = {}, event = "issue_comment") {
    return {
      action: "created",
      repository: { full_name: "team/project" },
      installation: { id: 456 },
      sender: { id: 42, login: "alice", type: "User" },
      ...(event === "issue_comment" ? { issue: { number: 7 } } : { pull_request: { number: 7 } }),
      comment: {
        id: 90,
        body: "@helper[bot] Hello",
        user: { id: 42, login: "alice", type: "User" },
      },
      ...overrides,
    };
  }
  function signed(body: unknown, delivery = "delivery-1", event = "issue_comment") {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return {
      method: "POST",
      body: raw,
      headers: {
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
        "x-github-delivery": delivery,
        "x-github-event": event,
      },
    };
  }
  test(
    "GitHub raw signatures, policy, event shapes and mention boundaries reject before execution",
    { timeout: 15000 },
    async () => {
      const dependencies: TriggerDependencies = {
        authenticate: async () => assert.fail("Webhook unexpectedly required team auth"),
        execute: async () => assert.fail("Rejected webhook reached durable execution"),
        submit: async () => assert.fail("Webhook bypassed durable execution"),
        status: async () => assert.fail("Webhook requested job status"),
      };
      const app = new Hono<TriggerAppEnv>().route("/triggers/github", create(dependencies));
      const env = {
        GITHUB_WEBHOOK_SECRET: secret,
        GITHUB_BOT_LOGIN: "helper[bot]",
        GITHUB_ACTORS: '["alice"]',
        GITHUB_APP_ID: "123",
        GITHUB_APP_PRIVATE_KEY: "unused-before-token-request",
        GITHUB_REPOSITORIES: '{"team/project":456}',
      };
      const core = { fetch: (url: string, init?: RequestInit) => app.request(url, init, env) };
      const send = (body: unknown, delivery?: string, event?: string) =>
        core.fetch("http://localhost/triggers/github", signed(body, delivery, event));
      assert.equal(
        (await app.request("http://localhost/triggers/github", signed(payload()), {})).status,
        503,
      );
      assert.equal(
        (await core.fetch("http://localhost/triggers/github", { method: "POST", body: "{}" }))
          .status,
        401,
      );
      const tampered = signed(payload());
      tampered.body += " ";
      assert.equal(
        (await core.fetch("http://localhost/triggers/github", tampered)).status,
        401,
        "Signature covers raw bytes",
      );
      assert.equal((await send("{")).status, 400);
      for (const invalid of ["null", "[]", "42", "{}", payload({ action: 1 })])
        assert.equal((await send(invalid)).status, 400);
      assert.equal((await send("x".repeat(32769))).status, 413);
      assert.equal((await send(payload({ repository: { full_name: "team/other" } }))).status, 403);
      assert.equal((await send(payload({ installation: { id: 457 } }))).status, 403);
      assert.equal(
        (
          await send(
            payload({
              sender: { id: 43, login: "mallory", type: "User" },
              comment: {
                id: 90,
                body: "@helper[bot] Hi",
                user: { id: 43, login: "mallory", type: "User" },
              },
            }),
          )
        ).status,
        403,
      );
      assert.equal(
        (await send(payload({ sender: { id: 43, login: "alice", type: "User" } }))).status,
        400,
        "Sender must match the comment author, not just its allowed login",
      );
      for (const body of [
        payload({ issue: { number: "7" } }),
        payload({ comment: { ...payload().comment, id: -1 } }),
        payload({ comment: { ...payload().comment, body: "x".repeat(16001) } }),
        payload({ comment: { ...payload().comment, in_reply_to_id: "90" } }),
      ])
        assert.equal((await send(body)).status, 400);
      assert.equal((await send(payload(), "../bad")).status, 400);
      for (const [login, type] of [
        ["helper[bot]", "User"],
        ["another[bot]", "Bot"],
      ]) {
        const user = { id: 42, login, type };
        assert.deepEqual(
          await (
            await send(payload({ sender: user, comment: { ...payload().comment, user } }))
          ).json(),
          { ignored: true },
        );
      }
      for (const body of [
        "ordinary text",
        "@helper[bot]-other",
        "email@helper[bot]",
        "@@helper[bot]",
        "@helper[bot] ",
        "@helper-other",
        "email@helper",
        "@@helper",
        "@helper ",
      ]) {
        assert.deepEqual(
          await (await send(payload({ comment: { ...payload().comment, body } }))).json(),
          { ignored: true },
        );
      }
      // People mention the App as `@slug`; the `[bot]` login suffix is only on the App's own comments.
      // Not ignored: it reaches execution, which this fixture has no delivery queue for (503).
      const plain = await send(
        payload({ comment: { ...payload().comment, body: "@helper Hello" } }),
        "plain-mention",
      );
      assert.equal(plain.status, 503);
      assert.deepEqual(await plain.json(), { error: "delivery_unavailable" });
      assert.deepEqual(await (await send(payload({ action: "edited" }))).json(), { ignored: true });
      assert.deepEqual(await (await send(payload(), "irrelevant", "push")).json(), {
        ignored: true,
      });
    },
  );
}
