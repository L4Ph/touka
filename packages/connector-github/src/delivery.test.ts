import { vi, test } from "vite-plus/test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { githubConnector } from "./index";
const session = "github-thread";
test("GitHub delivery bounds UTF-8 replies and classifies rate limits, vendor errors and App auth failures", async (t) => {
  const now = 1800000000000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let authError: { status?: number; retryAfter?: string; message?: string } | undefined;
  let tokenCalls = 0;
  const env = {
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    GITHUB_REPOSITORIES: '{"team/project":456}',
  };
  const connector = githubConnector(env);
  const context = {
    env,
    signal: new AbortController().signal,
    job: {
      trigger: "github",
      input: { sessionId: session, operationId: "reply", input: "Hello" },
      principal: { id: session, sessions: [session], resources: [] },
      reply: { repo: "team/project", number: 7 },
    },
    result: { text: "Answer" },
  };
  let response = new Response(null, { status: 201 });
  let transportFailure = false;
  let sends = 0;
  let expectedBody = "😀".repeat(15000) + "\n\n[Response truncated; see the session.]";
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    assert.ok(typeof url === "string" && init);
    if (url.includes("/access_tokens")) {
      tokenCalls++;
      if (authError) {
        if (!authError.status) throw new TypeError("network unavailable");
        return new Response(null, {
          status: authError.status,
          headers: authError.retryAfter ? { "retry-after": authError.retryAfter } : {},
        });
      }
      return Response.json({
        token: "boundary-token",
        expires_at: new Date(now + 3600000).toISOString(),
      });
    }
    sends++;
    assert.equal(url, "https://api.github.com/repos/team/project/issues/7/comments");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer boundary-token");
    assert.deepEqual(
      JSON.parse(String(init.body)),
      { body: expectedBody },
      "Reply content preserves complete UTF-8 characters and includes a visible notice when truncated",
    );
    if (transportFailure) throw new TypeError("network unavailable");
    return response;
  });
  context.result.text = "😀".repeat(16000);
  assert.deepEqual(
    await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
    { status: "delivered" },
  );
  context.result.text = "Answer";
  expectedBody = "Answer";
  for (const [status, headers, delay] of [
    [429, { "retry-after": "2" }, 2000],
    [403, { "retry-after": "3" }, 3000],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now / 1000 + 45) }, 45000],
    [429, { "retry-after": new Date(now + 60000).toUTCString() }, 60000],
    [429, { "retry-after": "99999" }, 3600000],
    [503, {}, undefined],
  ] as const) {
    response = new Response(null, { status, headers: new Headers(headers) });
    assert.deepEqual(
      await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
      { status: "retry", code: "github_rate_or_server_error", retryAfterMs: delay },
      `HTTP ${status} must preserve its retry delay`,
    );
  }
  for (const status of [403, 404, 422]) {
    response = new Response(null, { status });
    assert.deepEqual(
      await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
      { status: "failed", code: "github_reply_rejected" },
    );
  }
  response = new Response(null, { status: 401 });
  assert.deepEqual(
    await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
    { status: "failed", code: "github_unauthorized" },
  );
  const beforeRefresh = tokenCalls;
  transportFailure = true;
  assert.deepEqual(
    await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
    { status: "retry", code: "github_transport_failed" },
  );
  assert.equal(tokenCalls, beforeRefresh + 1, "Unauthorized installation token is evicted");
  connector.auth.invalidate("team/project", "reply");
  const sendsBeforeAuthFailure = sends;
  authError = Object.assign(new Error("github_http_403"), { status: 403, retryAfter: "30" });
  assert.deepEqual(
    await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
    { status: "retry", code: "github_auth_unavailable", retryAfterMs: 30000 },
    "Secondary rate limits during App token acquisition preserve the retry delay, unlike ordinary auth 403s",
  );
  for (const error of [
    Object.assign(new Error("limited"), { status: 429, retryAfter: "4" }),
    Object.assign(new Error("upstream"), { status: 502 }),
    new Error("github_transport_failed"),
  ]) {
    authError = error;
    const result = await connector.reply(
      "team/project",
      7,
      undefined,
      context.result.text,
      context.signal,
    );
    assert.deepEqual(result, {
      status: "retry",
      code: "github_auth_unavailable",
      retryAfterMs: error.message === "limited" ? 4000 : undefined,
    });
  }
  for (const status of [401, 403, 404]) {
    authError = Object.assign(new Error("denied"), { status });
    assert.deepEqual(
      await connector.reply("team/project", 7, undefined, context.result.text, context.signal),
      { status: "failed", code: "github_auth_failed" },
    );
  }
  assert.equal(
    sends,
    sendsBeforeAuthFailure,
    "App auth failures never send unauthenticated comments",
  );
});
