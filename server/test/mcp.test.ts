import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { Miniflare, Response as WorkerResponse } from "miniflare";

function reply(
  block: { type: string; text?: string; input?: object; name?: string; id?: string },
  stop: string,
) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "mcp-test",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: block.type === "text" ? { type: "text", text: "" } : { ...block, input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta:
        block.type === "text"
          ? { type: "text_delta", text: block.text }
          : { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stop, stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return new WorkerResponse(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

test(
  "Pi executes a granted MCP tool over Streamable HTTP and blocks ungranted tools before external dispatch",
  { timeout: 20000 },
  async () => {
    let remoteCalls = 0;
    let modelCalls = 0;
    const mcpRequests: string[] = [];
    const token = "mcp-runtime-token-at-least-32-characters";
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
          { token, id: "team", sessions: ["mcp"], resources: ["mcp:docs:search"] },
        ]),
        MODEL_PROVIDER: "anthropic",
        MODEL_ID: "claude-sonnet-4-5",
        ANTHROPIC_API_KEY: "fake-model-key",
        MCP_SERVERS: JSON.stringify([
          {
            id: "docs",
            url: "https://mcp.example/mcp",
            tools: ["search", "delete"],
            headers: { Authorization: "MCP_AUTH" },
          },
        ]),
        MCP_AUTH: "Bearer private-mcp-token",
      },
      outboundService: async (request: Request) => {
        if (new URL(request.url).hostname === "api.anthropic.com") {
          const body = (await request.json()) as any;
          modelCalls++;
          const deny = JSON.stringify(body.messages).includes("deny-delete");
          const last = body.messages.at(-1);
          const toolResult = last.content?.find?.((part: any) => part.type === "tool_result");
          if (toolResult) {
            assert.equal(Boolean(toolResult.is_error), deny);
            assert.match(JSON.stringify(toolResult), deny ? /mcp_forbidden/ : /Found Mandarin/);
            return reply(
              { type: "text", text: deny ? "Deletion denied" : "Found Mandarin" },
              "end_turn",
            );
          }
          return reply(
            {
              type: "tool_use",
              id: `tool-${modelCalls}`,
              name: "mcp_call_tool",
              input: {
                server: "docs",
                tool: deny ? "delete" : "search",
                arguments: { query: "Mandarin" },
              },
            },
            "tool_use",
          );
        }
        assert.equal(request.url, "https://mcp.example/mcp");
        assert.equal(request.headers.get("Authorization"), "Bearer private-mcp-token");
        if (request.method === "GET") return new WorkerResponse(null, { status: 405 });
        const call = (await request.json()) as any;
        mcpRequests.push(call.method);
        if (call.id === undefined) return new WorkerResponse(null, { status: 202 });
        let result: object;
        if (call.method === "initialize")
          result = {
            protocolVersion: call.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "docs", version: "1" },
          };
        else {
          assert.equal(call.method, "tools/call");
          assert.equal(call.params.name, "search");
          assert.deepEqual(call.params.arguments, { query: "Mandarin" });
          remoteCalls++;
          result = { content: [{ type: "text", text: "Found Mandarin" }] };
        }
        return WorkerResponse.json({ jsonrpc: "2.0", id: call.id, result });
      },
    });
    try {
      const base = await runtime.ready;
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      for (const [operationId, input, expected] of [
        ["search", "find docs", "Found Mandarin"],
        ["denied", "deny-delete", "Deletion denied"],
      ]) {
        const accepted = await fetch(new URL("/triggers/webhook", base), {
          method: "POST",
          headers,
          body: JSON.stringify({ sessionId: "mcp", operationId, input }),
        });
        assert.equal(accepted.status, 202);
        const deadline = Date.now() + 10000;
        for (;;) {
          const response = await fetch(
            new URL(`/api/sessions/mcp/operations/${operationId}`, base),
            { headers },
          );
          const result = (await response.json()) as any;
          if (result.status === "done") {
            assert.equal(result.text, expected);
            break;
          }
          if (result.status === "unanswered")
            assert.fail(
              JSON.stringify({
                result,
                modelCalls,
                remoteCalls,
                mcpRequests,
                transcript: await (
                  await fetch(new URL("/api/sessions/mcp/messages", base), { headers })
                ).json(),
              }),
            );
          assert.ok(Date.now() < deadline, "MCP operation did not settle");
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      assert.equal(remoteCalls, 1, "Denied MCP call never reaches external tool execution");
      assert.equal(modelCalls, 4);
    } finally {
      await runtime.dispose();
    }
  },
);
