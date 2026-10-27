import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { globSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare, Response as WorkerResponse } from "miniflare";

const origin = "https://localhost";
const token = "auth-test-machine-token-not-a-secret-00001";
const model = { provider: "anthropic", id: "claude-sonnet-4-5" };
const slackSecret = "local-slack-signing-secret";
const slackSession = "slack_a3af0b26ff5e0df02a16914133493e78773d6ff465a63255be899b34e1b58847";

function modelReply(tool: "read" | "write" | false) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "local",
        type: "message",
        role: "assistant",
        model: model.id,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? {
            type: "tool_use",
            id: tool,
            name: tool === "read" ? "github_read_file" : "github_create_branch",
            input: {},
          }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify(
              tool === "read"
                ? { repo: "owner/repo", path: "README.md", ref: "main" }
                : { repo: "owner/repo", branch: "agent/test", sha: "a".repeat(40) },
            ),
          }
        : { type: "text_delta", text: "Finished" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  failure: string,
): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(failure);
}
const modules = (dir: string) =>
  [`${dir}/index.js`, ...globSync(`${dir}/assets/*.js`)].map((path) => ({
    type: "ESModule" as const,
    path,
  }));

// Only GitHub's upstream OAuth protocol is replaced; cookies, auth, DB, core and WS are real.
function github(request: Request) {
  const url = new URL(request.url);
  if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token")
    return request.text().then(
      (body) =>
        new WorkerResponse(
          JSON.stringify({
            access_token: new URLSearchParams(body).get("code"),
            token_type: "bearer",
            scope: "user:email",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
  assert.equal(url.hostname, "api.github.com");
  const identity = request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
  const email = `${identity === "unverified" ? "alice" : identity}@example.com`;
  if (url.pathname === "/user")
    return new WorkerResponse(
      JSON.stringify({
        id: identity === "alice" ? 1 : identity === "bob" ? 2 : 3,
        login: identity,
        name: identity,
        email,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  assert.equal(url.pathname, "/user/emails");
  return new WorkerResponse(
    JSON.stringify([{ email, primary: true, verified: identity !== "unverified" }]),
    {
      headers: { "Content-Type": "application/json" },
    },
  );
}

test(
  "Better Auth team cookies share persisted sessions without sharing machine or tool authority",
  { timeout: 35000 },
  async () => {
    const state = await mkdtemp(join(tmpdir(), "shared-auth-"));
    let githubRequests = 0;
    const options = {
      durableObjectsPersist: join(state, "do"),
      d1Persist: join(state, "db"),
      workers: [
        {
          name: "core",
          modules: modules("dist/remote_agent_server"),
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            SESSIONS: { className: "SessionAgent", useSQLite: true },
            SESSION_DIRECTORY: { className: "SessionDirectory", useSQLite: true },
            TRIGGER_JOBS: { className: "TriggerJobs", useSQLite: true },
          },
          bindings: {
            TEAM_AUTH: JSON.stringify([
              {
                id: "machine",
                token,
                sessions: ["external-thread", "legacy-thread"],
                resources: [],
              },
            ]),
            MODEL_PROVIDER: model.provider,
            MODEL_ID: model.id,
            ANTHROPIC_API_KEY: "local-fake-key",
            WEB_RESOURCES: JSON.stringify(["github:owner/repo:read"]),
            GITHUB_APP_ID: "123",
            GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
              .privateKey.export({ type: "pkcs8", format: "pem" })
              .toString(),
            GITHUB_REPOSITORIES: JSON.stringify({ "owner/repo": 42 }),
            SLACK_SIGNING_SECRET: slackSecret,
            SLACK_ADMIN_TOKEN: "local-slack-admin-token",
            SLACK_WORKSPACES: JSON.stringify([
              { id: "T_AUTH", actors: ["U_AUTH"], botUserId: "B_AUTH", token: "local-bot-token" },
            ]),
          },
          outboundService: async (request: Request) => {
            const url = new URL(request.url);
            if (url.hostname === "slack.com") {
              assert.equal(url.pathname, "/api/chat.postMessage");
              return WorkerResponse.json({ ok: true });
            }
            if (url.hostname === "api.github.com") {
              githubRequests++;
              if (url.pathname === "/app/installations/42/access_tokens") {
                assert.equal(request.method, "POST");
                assert.deepEqual(await request.json(), {
                  repositories: ["repo"],
                  permissions: { contents: "read" },
                });
                return WorkerResponse.json(
                  {
                    token: "local-read-token",
                    expires_at: new Date(Date.now() + 3600000).toISOString(),
                  },
                  { status: 201 },
                );
              }
              assert.equal(request.method, "GET", "Denied writes must never reach GitHub");
              assert.equal(
                url.pathname + url.search,
                "/repos/owner/repo/contents/README.md?ref=main",
              );
              assert.equal(request.headers.get("authorization"), "Bearer local-read-token");
              return WorkerResponse.json({
                type: "file",
                encoding: "base64",
                sha: "a".repeat(40),
                content: Buffer.from("Authorized shared repository content").toString("base64"),
              });
            }
            assert.equal(url.hostname, "api.anthropic.com");
            const body = (await request.json()) as {
              messages: { role: string; content: string | { type: string }[] }[];
            };
            const turn = body.messages.reduce(
              (latest, message, index) =>
                message.role === "user" &&
                (typeof message.content === "string" ||
                  message.content.some((block) => block.type === "text"))
                  ? index
                  : latest,
              0,
            );
            const results = body.messages
              .slice(turn)
              .flatMap((message) => (typeof message.content === "string" ? [] : message.content))
              .filter((block) => block.type === "tool_result").length;
            return new WorkerResponse(
              modelReply(results === 0 ? "read" : results === 1 ? "write" : false),
              {
                headers: { "Content-Type": "text/event-stream" },
              },
            );
          },
        },
        {
          name: "web",
          modulesRoot: resolve(".."),
          modules: modules("../dist/ssr"),
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { DB: "auth-db" },
          bindings: {
            BETTER_AUTH_SECRET: "local-auth-secret-at-least-thirty-two-characters",
            AUTH_GITHUB_CLIENT_ID: "fake-client",
            AUTH_GITHUB_CLIENT_SECRET: "fake-secret",
            TEAM_EMAILS: "alice@example.com,bob@example.com",
          },
          serviceBindings: { AGENT_CORE: { name: "core", entrypoint: "WebGateway" } },
          outboundService: github,
        },
      ],
    };
    const legacy = new Miniflare({
      durableObjectsPersist: options.durableObjectsPersist,
      workers: [
        {
          ...options.workers[0],
          durableObjects: {
            SESSIONS: { className: "SessionAgent", useSQLite: true },
          },
        },
      ],
    });
    try {
      const created = await legacy.dispatchFetch(`${origin}/api/sessions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "legacy-thread" }),
      });
      assert.equal(created.status, 201);
    } finally {
      await legacy.dispose();
    }
    options.workers.reverse();
    let runtime = new Miniflare(options);
    const web = async (
      path: string,
      cookie = "",
      method = "GET",
      body?: unknown,
      requestOrigin: string | null = origin,
    ) => {
      return runtime.dispatchFetch(`${origin}${path}`, {
        method,
        headers: {
          ...(cookie ? { Cookie: cookie } : {}),
          ...(requestOrigin ? { Origin: requestOrigin } : {}),
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
      });
    };
    const completed = async (operationId: string) =>
      until(
        async () => {
          const response = await web(
            `/api/agent/sessions/external-thread/operations/${operationId}`,
            triggerViewer,
          );
          assert.equal(response.status, 200);
          return (await response.json()) as { status: string };
        },
        (operation) => operation.status === "done",
        `Trigger operation ${operationId} must complete`,
      );
    let triggerViewer = "";
    const continueTrigger = async (operationId: string) => {
      const before = await (
        await web("/api/agent/sessions/external-thread/messages", triggerViewer)
      ).text();
      const deniedTools = (transcript: string) =>
        (JSON.parse(transcript) as { messages: { kind: string }[] }).messages.filter(
          (message) =>
            message.kind === "pi.tool-result" &&
            JSON.stringify(message).includes("github_forbidden"),
        ).length;
      const requestsBefore = githubRequests;
      assert.equal(
        (
          await web("/api/agent/sessions/external-thread/inputs", triggerViewer, "POST", {
            operationId,
            input: `Continue trigger ${operationId}`,
          })
        ).status,
        202,
      );
      await completed(operationId);
      const history = await (
        await web("/api/agent/sessions/external-thread/messages", triggerViewer)
      ).text();
      assert.match(history, new RegExp(`Continue trigger ${operationId}`));
      assert.equal(
        deniedTools(history),
        deniedTools(before) + 2,
        "Both read and write tools must durably deny the trigger's empty grant on each Web continuation",
      );
      assert.doesNotMatch(history, /Authorized shared repository content/);
      assert.equal(
        githubRequests,
        requestsBefore,
        "Denied trigger tools must not request GitHub tokens or repository data",
      );
      return history;
    };
    const login = async (name: string) => {
      const start = await web("/api/auth/sign-in/social", "", "POST", {
        provider: "github",
        callbackURL: "/",
      });
      assert.equal(start.status, 200);
      const oauth = new URL(((await start.json()) as { url: string }).url);
      const cookie = start.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
      const callback = await web(
        `/api/auth/callback/github?code=${name}&state=${oauth.searchParams.get("state")}`,
        cookie,
      );
      assert.equal(callback.status, 302);
      if (["alice", "bob"].includes(name)) {
        const sessionCookie = callback.headers
          .getSetCookie()
          .find((value) => value.includes("session_token="));
        assert.ok(sessionCookie);
        assert.match(sessionCookie, /Secure/);
        assert.match(sessionCookie, /HttpOnly/);
        assert.match(sessionCookie, /SameSite=Lax/i);
      }
      return callback.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; ");
    };
    try {
      await runtime.ready;
      const db = await runtime.getD1Database("DB", "web");
      for (const file of globSync("../db/migrations/*.sql")) {
        for (const sql of readFileSync(file, "utf8").split("--> statement-breakpoint"))
          if (sql.trim()) await db.prepare(sql).run();
      }
      const anonymous = await web("/api/agent/sessions");
      assert.equal(anonymous.status, 401, await anonymous.text());
      const anonSocket = await runtime.dispatchFetch(
        `${origin}/api/agent/sessions/external-thread/events`,
        {
          headers: { Upgrade: "websocket", Origin: origin },
        },
      );
      assert.equal(anonSocket.status, 401);
      assert.equal(
        (
          await web("/api/auth/sign-up/email", "", "POST", {
            name: "intruder",
            email: "intruder@example.com",
            password: "not-allowed-password",
          })
        ).status,
        400,
      );
      const outsider = await login("outsider");
      assert.equal((await web("/api/agent/sessions", outsider)).status, 401);
      const unverified = await login("unverified");
      assert.equal((await web("/api/agent/sessions", unverified)).status, 401);
      const bob = await login("bob");
      const alice = await login("alice");
      assert.match(alice, /session_token=/);
      assert.match(bob, /session_token=/);
      assert.equal(
        (await web("/api/auth/sign-out", alice, "POST", {}, "https://evil.example")).status,
        403,
      );
      const own = await web("/api/auth/get-session", alice);
      assert.equal(
        ((await own.json()) as { user: { email: string } }).user.email,
        "alice@example.com",
      );
      assert.equal(
        (await web("/api/agent/sessions", alice, "GET", undefined, "https://evil.example")).status,
        403,
      );
      assert.equal(
        (await web("/api/agent/sessions", alice, "POST", { sessionId: "evil" }, null)).status,
        403,
      );
      const core = await runtime.getWorker("core");
      assert.equal(
        (await core.fetch(`${origin}/api/sessions`, { headers: { "x-team-user": "forged" } }))
          .status,
        401,
      );
      const machineHeaders = {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      };
      assert.equal(
        (
          await core.fetch(`${origin}/triggers/webhook`, {
            method: "POST",
            headers: machineHeaders,
            body: JSON.stringify({
              sessionId: "external-thread",
              operationId: "trigger-op",
              input: "Trigger message",
            }),
          })
        ).status,
        202,
      );
      triggerViewer = alice;
      await completed("trigger-op");
      const triggerHistory = await continueTrigger("continue-trigger");
      // If web continuation replaces the durable trigger grant, this original-grant retry fails.
      assert.equal(
        (
          await core.fetch(`${origin}/triggers/webhook`, {
            method: "POST",
            headers: machineHeaders,
            body: JSON.stringify({
              sessionId: "external-thread",
              operationId: "trigger-op",
              input: "Trigger message",
            }),
          })
        ).status,
        202,
      );
      // This trigger ID is absent from TEAM_AUTH and SESSION_INDEX_SEEDS: only submit can index it.
      const slackBody = JSON.stringify({
        type: "event_callback",
        team_id: "T_AUTH",
        event_id: "Ev_AUTH",
        event: {
          type: "app_mention",
          channel: "C_AUTH",
          user: "U_AUTH",
          ts: "1700000000.000001",
          text: "<@B_AUTH> New Slack conversation",
        },
      });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const slackSignature = `v0=${createHmac("sha256", slackSecret)
        .update(`v0:${timestamp}:${slackBody}`)
        .digest("hex")}`;
      const slackResponse = await core.fetch(`${origin}/triggers/slack`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-slack-request-timestamp": timestamp,
          "x-slack-signature": slackSignature,
        },
        body: slackBody,
      });
      assert.equal(slackResponse.status, 200);
      assert.deepEqual(await slackResponse.json(), { eventId: "Ev_AUTH", accepted: true });
      for (const member of [alice, bob]) {
        const discovered = await until(
          async () => {
            const response = await web("/api/agent/sessions", member);
            assert.equal(response.status, 200);
            return ((await response.json()) as { sessions: { sessionId: string }[] }).sessions.map(
              (session) => session.sessionId,
            );
          },
          (ids) => ids.includes(slackSession),
          "New signed Slack thread must be discoverable without allowlist/seed backfill",
        );
        assert.deepEqual(discovered, ["external-thread", "legacy-thread", slackSession]);
      }
      const list = await web("/api/agent/sessions", bob);
      assert.equal(list.headers.get("cache-control"), "no-store");
      assert.deepEqual(
        ((await list.json()) as { sessions: { sessionId: string }[] }).sessions.map(
          (s) => s.sessionId,
        ),
        ["external-thread", "legacy-thread", slackSession],
      );
      assert.equal(
        (await web("/api/agent/sessions", alice, "POST", { sessionId: "web-thread" })).status,
        201,
      );
      assert.equal(
        (await web("/api/agent/sessions", bob, "POST", { sessionId: "web-thread" })).status,
        409,
      );
      assert.equal(
        (
          await web("/api/agent/sessions/web-thread/inputs", alice, "POST", {
            operationId: "escalate",
            input: "run",
            resources: ["github:write:owner/repo"],
          })
        ).status,
        400,
      );
      const submitted = await web("/api/agent/sessions/web-thread/inputs", alice, "POST", {
        operationId: "web-op",
        input: "Shared persistent message",
      });
      assert.equal(submitted.status, 202);
      assert.equal(
        (
          await web("/api/agent/sessions/web-thread/inputs", bob, "POST", {
            operationId: "web-op",
            input: "Shared persistent message",
          })
        ).status,
        202,
      );
      const history = await until(
        async () => (await web("/api/agent/sessions/web-thread/messages", alice)).text(),
        (text) => text.includes("github_forbidden") && text.includes("Finished"),
        "Timed out waiting for durable tool denial",
      );
      assert.match(history, /github_forbidden/);
      assert.match(
        history,
        /Authorized shared repository content/,
        "Configured read authority must execute, not merely deny writes",
      );
      assert.match(history, /Shared persistent message/);
      assert.equal(
        await (await web("/api/agent/sessions/web-thread/messages", bob)).text(),
        history,
      );
      const first = (await (await web("/api/agent/sessions?limit=2", bob)).json()) as {
        sessions: { sessionId: string }[];
        next: string;
      };
      assert.deepEqual(
        first.sessions.map((session) => session.sessionId),
        ["external-thread", "legacy-thread"],
      );
      assert.equal(first.next, "legacy-thread");
      const second = (await (
        await web(`/api/agent/sessions?limit=2&after=${first.next}`, bob)
      ).json()) as { sessions: { sessionId: string }[]; next: null };
      assert.deepEqual(
        second.sessions.map((s) => s.sessionId),
        [slackSession, "web-thread"],
      );
      assert.equal(second.next, null);
      assert.equal((await web("/api/agent/sessions?limit=1000", bob)).status, 400);
      const worker = { fetch: runtime.dispatchFetch };
      const badSocket = await worker.fetch(`${origin}/api/agent/sessions/web-thread/events`, {
        headers: { Cookie: alice, Origin: "https://evil.example", Upgrade: "websocket" },
      });
      assert.equal(badSocket.status, 401);
      assert.deepEqual(await badSocket.json(), { error: { code: "unauthorized" } });
      const socketResponse = await worker.fetch(`${origin}/api/agent/sessions/web-thread/events`, {
        headers: { Cookie: alice, Origin: origin, Upgrade: "websocket" },
      });
      assert.equal(socketResponse.status, 101);
      const socket = socketResponse.webSocket!;
      socket.accept();
      const snapshot = await new Promise<string>((resolve) =>
        socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
      );
      assert.match(snapshot, /snapshot/);
      const closed = new Promise<number>((resolve) =>
        socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
      );
      assert.equal((await web("/api/auth/sign-out", alice, "POST", {})).status, 200);
      assert.equal((await web("/api/agent/sessions", alice)).status, 401);
      assert.equal(await closed, 1008);
      const afterLogout = await worker.fetch(`${origin}/api/agent/sessions/web-thread/events`, {
        headers: { Cookie: alice, Origin: origin, Upgrade: "websocket" },
      });
      assert.equal(afterLogout.status, 401);
      await runtime.dispose();
      runtime = new Miniflare(options);
      await runtime.ready;
      assert.equal(
        await (await web("/api/agent/sessions/web-thread/messages", bob)).text(),
        history,
      );
      const aliceReopened = await login("alice");
      triggerViewer = bob;
      assert.equal(
        await (await web("/api/agent/sessions/external-thread/messages", bob)).text(),
        triggerHistory,
        "Trigger tool denials and shared continuation must persist across reopen",
      );
      await continueTrigger("continue-trigger-reopened");
      for (const member of [aliceReopened, bob]) {
        const reopened = await web("/api/agent/sessions", member);
        assert.equal(reopened.status, 200);
        assert.deepEqual(
          ((await reopened.json()) as { sessions: { sessionId: string }[] }).sessions.map(
            (session) => session.sessionId,
          ),
          ["external-thread", "legacy-thread", slackSession, "web-thread"],
        );
        assert.match(
          await (await web(`/api/agent/sessions/${slackSession}/messages`, member)).text(),
          /New Slack conversation/,
        );
      }
      const reopenedDb = await runtime.getD1Database("DB", "web");
      for (const revoke of [
        "UPDATE user SET emailVerified = 0 WHERE email = 'bob@example.com'",
        "UPDATE user SET email = 'removed@example.com' WHERE email = 'bob@example.com'",
      ]) {
        const active = await runtime.dispatchFetch(
          `${origin}/api/agent/sessions/web-thread/events`,
          {
            headers: { Cookie: bob, Origin: origin, Upgrade: "websocket" },
          },
        );
        assert.equal(active.status, 101);
        const connection = active.webSocket!;
        connection.accept();
        await new Promise<void>((resolve) =>
          connection.addEventListener("message", () => resolve(), { once: true }),
        );
        const membershipClosed = new Promise<number>((resolve) =>
          connection.addEventListener("close", (event) => resolve(event.code), { once: true }),
        );
        await reopenedDb.prepare(revoke).run();
        const retained = await web("/api/auth/get-session", bob);
        assert.equal(retained.status, 200);
        assert.equal(
          ((await retained.json()) as { user: { email: string } }).user.email,
          revoke.includes("removed@example.com") ? "removed@example.com" : "bob@example.com",
          "Membership revocation must retain the real authenticated session",
        );
        assert.equal((await web("/api/agent/sessions", bob)).status, 403, revoke);
        const rejected = await runtime.dispatchFetch(
          `${origin}/api/agent/sessions/web-thread/events`,
          {
            headers: { Cookie: bob, Origin: origin, Upgrade: "websocket" },
          },
        );
        assert.equal(rejected.status, 403, revoke);
        assert.equal(
          await membershipClosed,
          1008,
          "Membership revocation must close an existing socket",
        );
        await reopenedDb
          .prepare(
            "UPDATE user SET emailVerified = 1, email = 'bob@example.com' WHERE email IN ('bob@example.com', 'removed@example.com')",
          )
          .run();
        assert.equal((await web("/api/agent/sessions", bob)).status, 200);
      }
      const webOptions = options.workers.find((worker) => worker.name === "web")!;
      for (const emails of ["", undefined]) {
        await runtime.dispose();
        if (emails === undefined) Reflect.deleteProperty(webOptions.bindings, "TEAM_EMAILS");
        else Object.assign(webOptions.bindings!, { TEAM_EMAILS: emails });
        runtime = new Miniflare(options);
        await runtime.ready;
        assert.equal(
          (await web("/api/agent/sessions", bob)).status,
          403,
          "Missing/empty membership config fails closed for a real session",
        );
        const rejected = await runtime.dispatchFetch(
          `${origin}/api/agent/sessions/web-thread/events`,
          {
            headers: { Cookie: bob, Origin: origin, Upgrade: "websocket" },
          },
        );
        assert.equal(rejected.status, 403);
      }
      await runtime.dispose();
      Object.assign(webOptions.bindings!, { TEAM_EMAILS: "alice@example.com,bob@example.com" });
      runtime = new Miniflare(options);
      await runtime.ready;
      const restoredDb = await runtime.getD1Database("DB", "web");
      await restoredDb.prepare("DELETE FROM session").run();
      assert.equal((await web("/api/agent/sessions", bob)).status, 401);
    } finally {
      await runtime.dispose();
      await rm(state, { recursive: true, force: true });
    }
  },
);
