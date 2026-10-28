import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { globSync } from "node:fs";

const token = "local-runtime-test-token-not-a-secret-0001";
const member = { id: "tester", token, sessions: ["allowed"], resources: [] };

test("local HTTP opens real Pi/Lifecycle SQLite, enforces auth, session ACL and payload bounds", async () => {
  const worker = {
    modules: [
      "dist/remote_agent_server/index.js",
      ...globSync("dist/remote_agent_server/assets/*.js"),
    ].map((path) => ({ type: "ESModule" as const, path })),
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: { SESSIONS: { className: "SessionAgent", useSQLite: true } },
    bindings: { TEAM_AUTH: JSON.stringify([member]) },
  };
  const runtime = new Miniflare({ workers: [worker] });
  try {
    const url = await runtime.ready;
    const get = (path: string, headers?: Record<string, string>) =>
      fetch(new URL(path, url), { headers });
    const health = await get("/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "remote-agent" });
    assert.equal((await get("/api/sessions/allowed/runtime")).status, 401);
    assert.equal(
      (await get("/api/sessions/allowed/runtime", { Authorization: "Bearer wrong" })).status,
      401,
    );
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await get("/api/sessions/denied/runtime", headers)).status, 403);
    const socket = await runtime.dispatchFetch("http://localhost/api/sessions/allowed/events", {
      headers: { Upgrade: "websocket" },
    });
    assert.equal(socket.status, 401);
    const opened = await get("/api/sessions/allowed/runtime", headers);
    assert.equal(opened.status, 200);
    assert.deepEqual(await opened.json(), {
      sessions: [{ id: "1", busy: false }],
      modelConfigured: false,
    });
    const oversized = await fetch(new URL("/api/sessions/allowed/runtime", url), {
      method: "POST",
      headers,
      body: "x".repeat(32_769),
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: { code: "payload_too_large" } });
    assert.equal(
      (await get("/api/sessions/allowed/runtime", { "x-team-user": "forged-user" })).status,
      401,
      "A Web identity header is never machine API authentication",
    );
    const submitted = await fetch(new URL("/triggers/webhook", url), {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "allowed", operationId: "headless", input: "Hello" }),
    });
    assert.equal(submitted.status, 202);
    const namespace = await runtime.getDurableObjectNamespace("SESSIONS");
    const direct = await namespace
      .get(namespace.idFromName("allowed"))
      .fetch("https://session/internal/web/allowed", {
        headers: { Upgrade: "websocket" },
      });
    if (direct.webSocket) {
      direct.webSocket.accept();
      direct.webSocket.close();
    }
    assert.equal(direct.status, 401, "Direct DO access has no trusted Web authentication bypass");
  } finally {
    await runtime.dispose();
  }
});
