# MCP Connector

Use remote MCP tools from Mandarin through the official MCP SDK v2 Streamable HTTP client, also used by the Cloudflare Agents SDK. Pi tool wrappers live in `server/src/tools/mcp/`. This is a Connector, not a Trigger.

```text
Pi → mcp_list_tools / mcp_call_tool → McpConnector → MCP server
```

## Configuration

Configure server-only environment variables on the core Worker. There is no chat API for registering URLs, credentials, or grants.

```json
[
  {
    "id": "docs",
    "url": "https://mcp.example.com/mcp",
    "tools": ["search", "read_document"],
    "headers": { "Authorization": "MCP_DOCS_AUTH" }
  }
]
```

Set this JSON as `MCP_SERVERS`, and set the `MCP_DOCS_AUTH` Secret to `Bearer <token>`. Omit headers for public servers. Map Cloudflare Access headers to secret names in the same way. Never embed secret values in the JSON.

Explicitly grant resources such as `mcp:docs:search`. New Web conversations use `WEB_RESOURCES`; machine inputs use their principal's resources. Changing configuration does not expand existing conversation grants. Both the tool allowlist and conversation grant are required; shared viewing grants no additional MCP access.

## Behavior and limits

- `mcp_list_tools`: without a server, list allowed server IDs and tool names; with a server, discover permitted tool descriptions/schemas. Never list URLs, headers, or secret names.
- `mcp_call_tool`: call a server/tool with arguments and preserve remote `isError`. Calls may write data, so Pi replay is unsafe.
- HTTPS only; reject embedded credentials, query/fragment, and redirects. Workers do not support `redirect:error`, so inspect manual responses and reject 3xx.
- Up to 16 servers and 64 allowed tools each. Arguments: 16 KiB; response bodies: 256 KiB; catalogs: 8 pages. Whole operations have a 30-second deadline and propagate caller cancellation.
- Open and close a connection per operation. MCP session IDs are not Pi conversation IDs. Reconnect on demand after DO restart.
- Normalize errors to `mcp_forbidden`, `mcp_unconfigured`, `mcp_invalid_arguments`, `mcp_aborted`, `mcp_timeout`, or `mcp_remote_error`; never expose SDK header/URL diagnostics in chat.
- Initial support covers public or header-authenticated Streamable HTTP. Interactive OAuth, stdio/SSE, resources/prompts, and ongoing subscriptions are unsupported. A 401 fails without alternative authentication or endpoint fallback.
- Treat remote output as untrusted. Read-only annotations do not relax grants or replay rules. Inspect external results before manually retrying an ambiguous write failure.

## Verification

`npm run verify:mcp` uses the real SDK for initialize, notifications, listing, and calls, faking only external HTTP. Real workerd/SQLite/Pi tests prove authorized results and rejection before unauthorized dispatch. These tests do not prove credentialed live-service connectivity.

Reference: https://developers.cloudflare.com/agents/tools/mcp/

Cloudflare's example uses `Agent.addMcpServer()` and the Vercel AI SDK. Mandarin uses a plain DO/PiHarness, so the Connector calls the same official MCP client SDK without introducing a second agent loop.
