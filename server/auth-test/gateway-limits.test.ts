import { test } from "node:test";
import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { Miniflare } from "miniflare";

const requestBytes = 32_768;

test(
  "WebGateway rejects oversized browser bodies before creating durable sessions",
  { timeout: 20000 },
  async (t) => {
    const runtime = new Miniflare({
      workers: [
        {
          name: "browser-proxy",
          modules: true,
          script: "export default { fetch(request, env) { return env.CORE.fetch(request); } };",
          serviceBindings: { CORE: { name: "core", entrypoint: "WebGateway" } },
          compatibilityDate: "2026-08-01",
        },
        {
          name: "core",
          modules: [
            "dist/remote_agent_server/index.js",
            ...globSync("dist/remote_agent_server/assets/*.js"),
          ].map((path) => ({ type: "ESModule" as const, path })),
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            SESSIONS: { className: "SessionAgent", useSQLite: true },
            SESSION_DIRECTORY: { className: "SessionDirectory", useSQLite: true },
          },
          bindings: {
            MODEL_PROVIDER: "anthropic",
            MODEL_ID: "claude-sonnet-4-5",
            ANTHROPIC_API_KEY: "local-unused-key",
          },
        },
      ],
    });
    const headers = { "x-team-user": "local-team-member", "Content-Type": "application/json" };
    try {
      await runtime.ready;
      for (const framing of ["known-length", "streamed"]) {
        await t.test(framing, async () => {
          const sessionId = `body-limit-${framing}`;
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
          assert.equal(
            accepted.status,
            201,
            "The inclusive body limit must still allow valid session creation",
          );
          assert.deepEqual(await accepted.json(), { sessionId });
        });
      }
    } finally {
      await runtime.dispose();
    }
  },
);
