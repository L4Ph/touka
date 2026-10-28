import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { Miniflare } from "miniflare";

const requestBytes = 32_768;
const token = "body-limit-machine-token-000000000001";

test.each(["known-length", "streamed"])(
  "management API rejects oversized %s bodies before creating durable sessions",
  { timeout: 20000 },
  async (framing) => {
    const sessionId = `body-limit-${framing}`;
    const runtime = new Miniflare({
      modules: [
        "dist/remote_agent_server/index.js",
        ...globSync("dist/remote_agent_server/assets/*.js"),
      ].map((path) => ({ type: "ESModule" as const, path })),
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { SESSIONS: { className: "SessionAgent", useSQLite: true } },
      bindings: {
        TEAM_AUTH: JSON.stringify([
          { id: "operator", token, sessions: [sessionId], resources: [] },
        ]),
        MODEL_PROVIDER: "anthropic",
        MODEL_ID: "claude-sonnet-4-5",
        ANTHROPIC_API_KEY: "local-unused-key",
      },
    });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    try {
      await runtime.ready;
      // JSON whitespace keeps the oversized request otherwise valid and capable of creating a session.
      const json = JSON.stringify({ sessionId });
      const body = json.padEnd(requestBytes + 1, " ");
      const response = await runtime.dispatchFetch("http://localhost/api/sessions", {
        method: "POST",
        headers: {
          ...headers,
          ...(framing === "known-length"
            ? { "Content-Length": String(Buffer.byteLength(body)) }
            : {}),
        },
        body:
          framing === "known-length"
            ? body
            : new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(body.slice(0, requestBytes)));
                  controller.enqueue(new TextEncoder().encode(body.slice(requestBytes)));
                  controller.close();
                },
              }),
        duplex: "half",
      });
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: { code: "payload_too_large" } });
      const absent = await runtime.dispatchFetch(`http://localhost/api/sessions/${sessionId}`, {
        headers,
      });
      assert.equal(absent.status, 404, "Rejected bodies must not create a durable session");
      const accepted = await runtime.dispatchFetch("http://localhost/api/sessions", {
        method: "POST",
        headers,
        body: json.padEnd(requestBytes, " "),
      });
      assert.equal(accepted.status, 201, "The inclusive body limit allows valid session creation");
      assert.deepEqual(await accepted.json(), { sessionId });
    } finally {
      await runtime.dispose();
    }
  },
);
