import { test } from "node:test";
import assert from "node:assert/strict";
import { McpConnector } from "./index";
import { create } from "../../../server/src/tools/mcp/index";

const policy = {
  sessionId: "thread",
  principal: { id: "alice", sessions: ["thread"], resources: ["mcp:docs:search"] },
};
const env = {
  MCP_SERVERS: JSON.stringify([
    {
      id: "docs",
      url: "https://mcp.example/mcp",
      tools: ["search", "delete"],
      headers: { Authorization: "MCP_DOCS_AUTH" },
    },
  ]),
  MCP_DOCS_AUTH: "Bearer private-service-key",
};
function remote() {
  const calls: { method: string; params?: any }[] = [];
  const http: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    assert.equal(req.url, "https://mcp.example/mcp");
    assert.equal(req.headers.get("Authorization"), env.MCP_DOCS_AUTH);
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal);
    if (req.method === "GET") return new Response(null, { status: 405 });
    const request = (await req.json()) as { id?: number; method: string; params?: any };
    calls.push(request);
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    switch (request.method) {
      case "initialize":
        result = {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "docs", version: "1" },
        };
        break;
      case "tools/list":
        result = {
          tools: [
            {
              name: "search",
              description: "Find a document",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            },
            { name: "delete", inputSchema: { type: "object" } },
          ],
        };
        break;
      case "tools/call":
        result = {
          content: [{ type: "text", text: `Found ${request.params.arguments.query}` }],
          isError: request.params.arguments.query === "fail",
        };
        break;
      default:
        throw new Error(`Unexpected external method ${request.method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  };
  return { http, calls };
}

void test("MCP uses the real SDK handshake, filters tools by grants, and calls the configured endpoint without exposing credentials", async () => {
  const upstream = remote();
  const connector = new McpConnector(env, policy, upstream.http);
  assert.deepEqual(connector.servers(), [{ id: "docs", tools: ["search"] }]);
  const tools = await connector.listTools("docs");
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["search"],
  );
  assert.equal(tools[0].description, "Find a document");
  const result = await connector.callTool("docs", "search", { query: "Mandarin" });
  assert.deepEqual(result.content, [{ type: "text", text: "Found Mandarin" }]);
  assert.deepEqual(
    upstream.calls.filter((call) => call.method === "tools/call").map((call) => call.params),
    [{ name: "search", arguments: { query: "Mandarin" } }],
  );
  assert.ok(
    !JSON.stringify({ tools, result, servers: connector.servers() }).includes(
      "private-service-key",
    ),
  );
});

void test("MCP rejects ungranted tools, sessions, invalid arguments and operator config before network I/O", async () => {
  let requests = 0;
  const http: typeof fetch = async () => {
    requests++;
    throw new Error("must not reach remote");
  };
  const connector = new McpConnector(env, policy, http);
  await assert.rejects(connector.callTool("docs", "delete", {}), /mcp_forbidden/);
  await assert.rejects(connector.callTool("unknown", "search", {}), /mcp_forbidden/);
  await assert.rejects(
    connector.callTool("docs", "search", { query: "x".repeat(20000) }),
    /mcp_invalid_arguments/,
  );
  const forbidden = new McpConnector(env, { ...policy, sessionId: "other" }, http);
  assert.deepEqual(forbidden.servers(), []);
  await assert.rejects(forbidden.listTools("docs"), /mcp_forbidden/);
  for (const MCP_SERVERS of [
    "{",
    "{}",
    "null",
    JSON.stringify([{ id: "bad", url: "http://internal", tools: ["search"] }]),
    JSON.stringify([{ id: "bad", url: "https://user:pass@mcp.example", tools: ["search"] }]),
  ]) {
    assert.throws(
      () => new McpConnector({ MCP_SERVERS }, policy, http).servers(),
      /mcp_unconfigured/,
    );
  }
  await assert.rejects(
    new McpConnector({ MCP_SERVERS: env.MCP_SERVERS }, policy, http).listTools("docs"),
    /mcp_unconfigured/,
  );
  await assert.rejects(
    new McpConnector({ ...env, MCP_DOCS_AUTH: "secret\u0001value" }, policy, http).listTools(
      "docs",
    ),
    { message: "mcp_unconfigured" },
  );
  assert.equal(requests, 0);
});

void test("MCP cancellation and remote errors are bounded and sanitized, and an unconfigured connector stays inert", async () => {
  const signal = AbortSignal.abort();
  const http: typeof fetch = async () => {
    throw new Error("private-service-key in upstream diagnostic");
  };
  const connector = new McpConnector(env, policy, http);
  await assert.rejects(connector.listTools("docs", signal), { message: "mcp_aborted" });
  await assert.rejects(connector.callTool("docs", "search", {}), { message: "mcp_remote_error" });
  assert.deepEqual(new McpConnector({}, policy, http).servers(), []);
  const flooded: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === "GET") return new Response(null, { status: 405 });
    const call = (await request.json()) as any;
    if (call.id === undefined) return new Response(null, { status: 202 });
    const result =
      call.method === "initialize"
        ? {
            protocolVersion: call.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "docs", version: "1" },
          }
        : { content: [{ type: "text", text: "x".repeat(300000) }] };
    return Response.json({ jsonrpc: "2.0", id: call.id, result });
  };
  await assert.rejects(new McpConnector(env, policy, flooded).callTool("docs", "search", {}), {
    message: "mcp_remote_error",
  });
});

void test("Pi MCP tools reuse the connector and preserve unsafe-call and remote isError semantics", async (t) => {
  const upstream = remote();
  t.mock.method(globalThis, "fetch", upstream.http);
  const extension = create({ env: env as any, ...policy });
  async function invoke(name: string, input: unknown) {
    const tool = extension.tools?.find((entry) => entry.name === name);
    assert.ok(tool);
    return Reflect.apply(tool.execute, tool, [
      input,
      undefined,
      { abortSignal: new AbortController().signal },
    ]);
  }
  const available = await invoke("mcp_list_tools", {});
  assert.deepEqual(JSON.parse(available.output[0].text), [{ id: "docs", tools: ["search"] }]);
  const listed = await invoke("mcp_list_tools", { server: "docs" });
  assert.equal(JSON.parse(listed.output[0].text)[0].name, "search");
  const result = await invoke("mcp_call_tool", {
    server: "docs",
    tool: "search",
    arguments: { query: "help" },
  });
  assert.deepEqual(JSON.parse(result.output[0].text).content, [
    { type: "text", text: "Found help" },
  ]);
  assert.equal(result.isError, false);
  const failed = await invoke("mcp_call_tool", {
    server: "docs",
    tool: "search",
    arguments: { query: "fail" },
  });
  assert.equal(failed.isError, true);
  assert.equal(extension.tools?.find((tool) => tool.name === "mcp_call_tool")?.replay, "unsafe");
  await assert.rejects(
    invoke("mcp_call_tool", { server: "docs", tool: "delete", arguments: {} }),
    /mcp_forbidden/,
  );
});
