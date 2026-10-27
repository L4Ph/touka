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
    const client = new Client({ name: "Mandarin", version: "1.0.0" });
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
