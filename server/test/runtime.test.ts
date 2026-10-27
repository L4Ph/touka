import { test } from "node:test";
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
  } finally {
    await runtime.dispose();
  }
});
