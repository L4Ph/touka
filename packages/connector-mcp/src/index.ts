import type nodeAssert from "node:assert/strict";
import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/client";
import type { Principal } from "@remote-agent/agent-contract";

export type McpEnvironment = { MCP_SERVERS?: string };
type Server = { id: string; url: string; tools: string[]; headers?: Record<string, string> };
type Access = { readonly sessionId: string; readonly principal: Principal };
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const toolName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);
const LIMIT = 256 * 1024;

function servers(raw: string | undefined): Server[] {
  if (!raw) return [];
  try {
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values) || values.length > 16) throw new Error();
    const ids = new Set<string>();
    for (const server of values) {
      const url = new URL(server.url);
      if (
        !identifier(server.id) ||
        ids.has(server.id) ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !Array.isArray(server.tools) ||
        !server.tools.length ||
        server.tools.length > 64 ||
        !server.tools.every(toolName) ||
        (server.headers !== undefined &&
          (!server.headers ||
            typeof server.headers !== "object" ||
            Array.isArray(server.headers) ||
            Object.keys(server.headers).length > 16 ||
            Object.entries(server.headers).some(
              ([name, variable]) =>
                !/^[a-zA-Z0-9-]{1,64}$/.test(name) ||
                typeof variable !== "string" ||
                !/^[A-Z][A-Z0-9_]{0,127}$/.test(variable),
            )))
      )
        throw new Error();
      ids.add(server.id);
    }
    return values;
  } catch {
    throw new Error("mcp_unconfigured");
  }
}

/** Operator-defined endpoints only. A fresh protocol connection is closed after each operation. */
export class McpConnector<Env extends McpEnvironment> {
  constructor(
    private readonly env: Env,
    private readonly access: Access,
    private readonly http: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private granted(server: string, tool: string) {
    return (
      this.access.principal.sessions.includes(this.access.sessionId) &&
      this.access.principal.resources.includes(`mcp:${server}:${tool}`)
    );
  }
  servers() {
    return servers(this.env.MCP_SERVERS)
      .filter((server) => server.tools.some((tool) => this.granted(server.id, tool)))
      .map((server) => ({
        id: server.id,
        tools: server.tools.filter((tool) => this.granted(server.id, tool)),
      }));
  }
  private server(id: string, tool?: string) {
    const server = servers(this.env.MCP_SERVERS).find((entry) => entry.id === id);
    if (
      !server ||
      (tool
        ? !server.tools.includes(tool) || !this.granted(id, tool)
        : !server.tools.some((name) => this.granted(id, name)))
    )
      throw new Error("mcp_forbidden");
    return server;
  }
  private async run<T>(
    server: Server,
    signal: AbortSignal | undefined,
    work: (client: Client, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const headers = new Headers();
    for (const [name, variable] of Object.entries(server.headers ?? {})) {
      const value: unknown = Reflect.get(this.env, variable);
      if (typeof value !== "string" || !value.trim() || /[^\x20-\x7e\t]/.test(value))
        throw new Error("mcp_unconfigured");
      headers.set(name, value);
    }
    const bounded = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers, redirect: "manual" },
      fetch: async (input, init) => {
        const response = await this.http(input, {
          ...init,
          redirect: "manual",
          signal: AbortSignal.any([bounded, ...(init?.signal ? [init.signal] : [])]),
        });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          throw new Error("mcp_redirect_denied");
        }
        if (!response.body) return response;
        let bytes = 0;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              bytes += chunk.byteLength;
              if (bytes > LIMIT) throw new Error("mcp_output_limit");
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });
    const client = new Client({ name: "Touka", version: "1.0.0" });
    try {
      bounded.throwIfAborted();
      await client.connect(transport, { signal: bounded, timeout: 30000 });
      return await work(client, bounded);
    } catch {
      if (signal?.aborted) throw new Error("mcp_aborted");
      if (bounded.aborted) throw new Error("mcp_timeout");
      // SDK errors may contain token-bearing headers or remote diagnostics.
      throw new Error("mcp_remote_error");
    } finally {
      await client.close().catch(() => {});
    }
  }
  async listTools(id: string, signal?: AbortSignal): Promise<Tool[]> {
    const server = this.server(id);
    return this.run(server, signal, async (client, abort) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 8; page++) {
        const result = await client.listTools({ cursor }, { signal: abort, timeout: 30000 });
        tools.push(
          ...result.tools.filter(
            (tool) => server.tools.includes(tool.name) && this.granted(id, tool.name),
          ),
        );
        if (tools.length > 64 || JSON.stringify(tools).length > LIMIT)
          throw new Error("mcp_catalog_limit");
        cursor = result.nextCursor;
        if (!cursor) return tools;
      }
      throw new Error("mcp_catalog_limit");
    });
  }
  async callTool(
    id: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const server = this.server(id, name);
    if (
      !args ||
      Array.isArray(args) ||
      typeof args !== "object" ||
      new TextEncoder().encode(JSON.stringify(args)).length > 16384
    )
      throw new Error("mcp_invalid_arguments");
    return this.run(server, signal, (client, abort) =>
      client.callTool({ name, arguments: args }, { signal: abort, timeout: 30000 }),
    );
  }
}

if (import.meta.vitest) {
  const { vi, test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { create } = await import("../../../server/src/tools/mcp/index");

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

  test("MCP uses the real SDK handshake, filters tools by grants, and calls the configured endpoint without exposing credentials", async () => {
    const upstream = remote();
    const connector = new McpConnector(env, policy, upstream.http);
    assert.deepEqual(connector.servers(), [{ id: "docs", tools: ["search"] }]);
    const tools = await connector.listTools("docs");
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["search"],
    );
    assert.equal(tools[0].description, "Find a document");
    const result = await connector.callTool("docs", "search", { query: "Touka" });
    assert.deepEqual(result.content, [{ type: "text", text: "Found Touka" }]);
    assert.deepEqual(
      upstream.calls.filter((call) => call.method === "tools/call").map((call) => call.params),
      [{ name: "search", arguments: { query: "Touka" } }],
    );
    assert.ok(
      !JSON.stringify({ tools, result, servers: connector.servers() }).includes(
        "private-service-key",
      ),
    );
  });

  test("MCP rejects ungranted tools, sessions, invalid arguments and operator config before network I/O", async () => {
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

  test("MCP cancellation and remote errors are bounded and sanitized, and an unconfigured connector stays inert", async () => {
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

  test("Pi MCP tools reuse the connector and preserve unsafe-call and remote isError semantics", async (t) => {
    const upstream = remote();
    vi.spyOn(globalThis, "fetch").mockImplementation(upstream.http);
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
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;

  const env = {
    MCP_SERVERS: JSON.stringify([
      { id: "docs", url: "https://mcp.example/mcp", tools: ["search"] },
    ]),
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
    const pending = new McpConnector(env, access, http).callTool(
      "docs",
      "search",
      {},
      abort.signal,
    );
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
}
