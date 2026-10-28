# Mandarin

A general-purpose, durable remote agent for a private team, built on Cloudflare Workers with Pi Durable, pi-ai, and the Agents SDK. The Web UI uses Void React Pages SSR and Vite+.

## Development

Use Node 24.11+ and [Vite+](https://viteplus.dev/guide/). The project pins Vite+ 1.4.0 and uses npm through Vite+'s package-manager support.

```sh
vp install
vp exec playwright install chrome
vp run verify
```

`vp run verify` builds both Workers, runs all Vitest tests through `vp test`, and runs formatting, linting, and type checking through `vp check`. Browser tests use headless Google Chrome. External OAuth, LLM, and service APIs are faked; the Workers, SQLite, D1, HTTP, and WebSocket boundaries run locally.

```sh
vp dev                       # Void Web UI
vp -C server dev             # Independent agent Worker
vp run build:all             # Build both Workers before runtime tests
vp test                      # All tests
vp test connector-mcp        # Filter tests by path
vp test auth-test web-test   # Authentication and browser tests
vp check                     # Format, lint, and types
```

Runtime tests read the built Workers, so rebuild after server changes. Test configuration lives in `vite.config.ts`; there is no separate Node test runner. CI uses `voidzero-dev/setup-vp` and the same `vp run verify` task.

## Architecture

- **Agent Core** owns sessions and execution, independent of the initiating service. One thread maps to one Session Durable Object and one Pi conversation.
- **Connectors** own external authentication, data access, operations, and resource permissions: `packages/connector-{github,slack,discord,mcp}`.
- **Triggers** receive events, authenticate/filter them, map conversations, accept input durably, and route replies: `packages/trigger-{github,slack,discord,webhook}`.
- **Tools** expose authorized Connector operations and isolated code execution to Pi: `server/src/tools/`.

A Web-created conversation can use a Connector without selecting a Trigger. Trigger invocation does not automatically grant write access. [Connection contracts](docs/connections.md) describe dependency direction and reply delivery.

## Authentication and shared conversations

The root Web Worker uses Void's Better Auth integration. Configure these server-only values in root `.dev.vars` locally:

- `TEAM_EMAILS`: comma-separated, exact verified team email addresses. Missing configuration denies access.
- `BETTER_AUTH_SECRET`: the authentication secret.
- `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET`: credentials for the default GitHub OAuth provider, separate from the bot GitHub App.

`AGENT_CORE` is a service binding to the independent core Worker's named `WebGateway` entry point. Browsers use the same-origin `/api/agent/*` cookie-authenticated proxy; they receive no machine bearer token, provider key, or configurable core URL. Authentication SQL migrations are in `db/migrations/`.

All authenticated team members can view, continue, stop, retry, and select models for the same conversations, including Trigger-created threads. Viewing does not expand the conversation's persisted Tool grants. New Web conversations use operator-configured `WEB_RESOURCES`; the default grants nothing.

See [shared Web authentication](docs/shared-web-auth.md) for deployment bindings, membership and session revocation, directory pagination, and existing-session indexing. `SESSION_INDEX_SEEDS` registers older unindexed thread IDs because Durable Objects cannot be enumerated.

## Models

Set `MODEL_PROVIDER` and `MODEL_ID` in server `.dev.vars` for defaults. pi-ai's bundled providers are registered directly; configure their documented server secret names, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GROQ_API_KEY`. AI Gateway is optional, never an implicit route or fallback.

Register compatible endpoints with server-only `MODEL_PROVIDERS` JSON:

```json
[
  {
    "id": "team-inference",
    "api": "openai-completions",
    "baseUrl": "https://inference.example.com/v1",
    "auth": { "env": "TEAM_INFERENCE_SECRET" },
    "models": [
      {
        "id": "team-chat",
        "name": "Team Chat",
        "reasoning": false,
        "input": ["text"],
        "contextWindow": 8192,
        "maxTokens": 1024,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        "compat": { "supportsDeveloperRole": false, "maxTokensField": "max_tokens" }
      }
    ]
  }
]
```

Set `TEAM_INFERENCE_SECRET` separately, then choose `team-inference` / `team-chat`. JSON configuration supports `openai-completions`, `openai-responses`, and `anthropic-messages`; explicit `auth: {"keyless": true}` supports keyless endpoints. `server/src/provider-config.ts` defines validation and limits.

For other SDK APIs, complete metadata, or custom authentication, register native pi-ai `Provider` objects in `server/src/operator-providers.ts`. Registration order is built-ins, JSON, then the operator array. Reusing a provider ID explicitly replaces it; failure never selects another provider. Clients may select registered models but cannot register endpoints or credentials.

Not every pi-ai transport or ambient credential mechanism is supported by workerd. Catalog presence and configured status are not live-connectivity guarantees. Provider OAuth login, credential files, and dynamic catalog refresh are not implemented.

## External services

- **GitHub:** use the existing bot GitHub App. Configure the allowed repository-to-installation map, actors, webhook secret, App ID/private key, and bot login. [GitHub Trigger setup](packages/trigger-github/README.md).
- **Slack:** mention-driven thread conversations through `slack-cloudflare-workers`, with workspace/actor policy and durable replies. [Slack Trigger setup](packages/trigger-slack/README.md).
- **Discord:** signed HTTP Interactions through `discord-hono`, using `/ask prompt:<task>`. Ordinary channels share channel-scoped conversations; real threads use their thread ID. Gateway mentions, DMs, and implicit bot fallback are unsupported. [Discord Trigger setup](packages/trigger-discord/README.md).
- **MCP:** Streamable HTTP discovery and calls through `mcp_list_tools` / `mcp_call_tool`. Configure `MCP_SERVERS`, secret-referenced headers, and explicit `mcp:<server>:<tool>` grants. Interactive OAuth, stdio/legacy SSE, resources, and prompts are unsupported. [MCP Connector setup](packages/connector-mcp/README.md).
- **Sandbox:** isolated Python/JavaScript and file tools require explicit container provisioning. No host shell or application secrets are exposed. [Sandbox setup and limits](server/src/tools/sandbox/README.md).

`env.example` lists server settings. Never place credentials in `VITE_*` variables, browser storage, or chat messages. Core secrets belong in `server/.dev.vars`; Web secrets belong in root `.dev.vars`.

## Machine Webhooks and operations

`TEAM_AUTH` is a server-only JSON array of `{id, token, sessions, resources}`. Tokens must contain at least 32 random characters. Session access and outbound resource grants are separate; browser users do not use these tokens.

```sh
curl http://127.0.0.1:8787/triggers/webhook \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sessionId":"session-id","operationId":"stable-id","input":"Hello"}'
```

The endpoint returns 202 after durable acceptance, without waiting for model completion. Reusing an operation ID preserves its first input and returns `accepted:false`. Queue exhaustion returns 429. Machine `/api/*` routes require bearer authentication; Web users access equivalent controls through the authenticated proxy.

Operations expose `queued`, `running`, `parked`, `done`, or `unanswered`. Authenticated retry resumes parked tasks; unanswered is terminal and needs a new operation ID after configuration is fixed. Model changes affect the next call, not an in-flight request. Registered tools enforce explicit grants and conservative replay safety; code work stops at PR creation, not merge or deployment.

For a standalone local core runtime:

```sh
vp run build:server
vp -C server run launch       # Foreground, localhost:8787
vp -C server run doctor       # Read-only health check
vp -C server run drive        # Set AGENT_TOKEN and AGENT_SESSION first
vp -C server run cleanup      # Stop only the managed runtime; preserve data
```

## Limits

- Input deduplication is not exactly-once external delivery. Model calls or replies can repeat across crash boundaries; inspect external results before retrying ambiguous writes.
- Unconfirmed Web input lives in page memory and is lost on reload or tab closure. Check shared history before resending. Stop and model changes affect all viewers.
- Operation expiry, history deletion, cursor-based event replay, and workspace backups are not implemented. WebSockets reconnect from a fresh snapshot. Sandbox workspaces are ephemeral.
- Real Slack/GitHub/Discord/MCP/LLM connectivity, Docker/Cloudflare Containers, and production deployment require operator setup and have not been verified here.
- Dependency advisories remain tracked in `.r5/issues/remote-agent/07-dependency-advisories.json`. Do not expose development servers publicly or apply breaking `audit fix --force` downgrades.
