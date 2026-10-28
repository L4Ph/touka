import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { McpConnector } from "./index";

const env = {
  MCP_SERVERS: JSON.stringify([{ id: "docs", url: "https://mcp.example/mcp", tools: ["search"] }]),
};
const access = {
  sessionId: "one",
  principal: { id: "team", sessions: ["one"], resources: ["mcp:docs:search"] },
};

test("MCP stops in-flight HTTP on caller cancellation", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const http: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      assert.ok(init?.signal);
      init.signal.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      started();
    });
  const abort = new AbortController();
  const pending = new McpConnector(env, access, http).callTool("docs", "search", {}, abort.signal);
  await entered;
  abort.abort();
  await assert.rejects(pending, { message: "mcp_aborted" });
});

test("MCP rejects redirect and authentication responses without following or exposing diagnostics", async () => {
  for (const status of [302, 307, 401, 403, 500]) {
    let calls = 0;
    const http: typeof fetch = async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, "manual");
      return new Response("sensitive upstream diagnostic", {
        status,
        headers: { Location: "https://other.example/private" },
      });
    };
    await assert.rejects(new McpConnector(env, access, http).callTool("docs", "search", {}), {
      message: "mcp_remote_error",
    });
    assert.equal(calls, 1, "No implicit auth, redirect, or side-effecting call retry");
  }
});
