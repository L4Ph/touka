import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { readFile, writeFile } from "node:fs/promises";
import { globSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

const command = process.argv[2];
const base = process.env.AGENT_URL ?? "http://127.0.0.1:8787";
const pidFile = new URL("../.runtime.pid", import.meta.url);
if (command === "launch") {
  await writeFile(pidFile, String(process.pid), { flag: "wx" });
  const runtime = new Miniflare({
    host: "127.0.0.1",
    port: 8787,
    modules: [
      "dist/remote_agent_server/index.js",
      ...globSync("dist/remote_agent_server/assets/*.js"),
    ].map((path) => ({ type: "ESModule", path })),
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      SESSIONS: { className: "SessionAgent", useSQLite: true },
      TRIGGER_JOBS: { className: "TriggerJobs", useSQLite: true },
    },
    durableObjectsPersist: ".runtime/state",
    // Local server inherits operator environment, including arbitrary provider secrets.
    bindings: Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined),
    ),
  });
  const close = async () => {
    unlinkSync(pidFile);
    await runtime.dispose();
  };
  process.prependOnceListener("SIGTERM", () => {
    void close();
  });
  process.prependOnceListener("SIGINT", () => {
    void close();
  });
  try {
    await runtime.ready;
  } catch (error) {
    await close();
    throw error;
  }
} else if (command === "cleanup") {
  const pid = Number(await readFile(pidFile, "utf8"));
  assert(Number.isSafeInteger(pid) && pid > 1, "Invalid runtime PID");
  const args = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  assert(
    args.includes("scripts/runtime.mjs launch"),
    "PID is not the managed runtime; refusing to stop it",
  );
  process.kill(pid, "SIGTERM");
} else if (command === "doctor" || command === "drive") {
  const health = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(5000) });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "remote-agent" });
  if (command === "drive") {
    assert(
      process.env.AGENT_TOKEN && process.env.AGENT_SESSION,
      "Set AGENT_TOKEN and AGENT_SESSION",
    );
    const path = `/api/sessions/${encodeURIComponent(process.env.AGENT_SESSION)}/runtime`;
    assert.equal((await fetch(new URL(path, base))).status, 401);
    const response = await fetch(new URL(path, base), {
      headers: { Authorization: `Bearer ${process.env.AGENT_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert(
      state.sessions.some((session) => session.id === "1"),
      "Pi root session is missing",
    );
  }
} else {
  throw new Error("Expected launch, doctor, drive or cleanup");
}
