# Operations

Deployment, authentication, models, the management API and known limits.

## Cloudflare toolchain

`server/cloudflare.config.ts` is the typed configuration, using `cf/config` and Cloudflare Vite plugin v2 beta. The CLI and plugin beta versions are pinned in `server/package.json`. The plugin generates native Build Output under `server/.cloudflare/output/` and runtime types under `server/.cloudflare/types/`.

```sh
vp run verify                         # Build, all tests, format/lint/types
vp run deploy:dry                     # Build and validate without uploading
vp run deploy                         # Deploy with the project-local cf CLI
# From server/: cf dev, cf build, cf deploy
```

`cf` only looks for `@cloudflare/vite-plugin` in `server/node_modules`, but npm hoists it to the repository root, so `server`'s `postinstall` links it back in. If `cf` reports the plugin as not installed, run `npm install` again.

The account comes from `CLOUDFLARE_ACCOUNT_ID` in your shell (or `cf login`'s only account). `vp run deploy` uploads `server/.env.local` as the Worker's secrets when it exists (a Worker that does not exist yet cannot take secrets in advance, and `cf workers secrets bulk` needs an existing Worker), and deploys without it otherwise, so later deploys keep the secrets already stored. Every server secret must be declared in `server/cloudflare.config.ts`; undeclared names never reach the Worker, and every declared one is required at deploy, so declare only the integrations in use. The `deploy` scripts do not take extra flags: a root `vp run` script inserts a `--` that makes `cf` ignore every flag after it, so call `vp -C server exec cf deploy <flags>` for anything else.

Durable Object lifecycle is declared with `exports.durableObject` instead of migration tags. Nothing has been deployed yet, so class and export names are free to change; once a Worker is deployed with declarative exports, it cannot return to the legacy migration-array flow.

## Authentication and session access

Set server-only `TEAM_AUTH` to a JSON array of `{id, token, sessions, resources}`. Tokens must contain at least 32 random characters. Missing or invalid configuration fails closed. Send `Authorization: Bearer <token>` to the management API and authenticated Webhook Trigger.

Session access and outbound resource grants are separate. `GET /api/sessions` lists only existing conversations explicitly allowed by the caller's `sessions` array; add deterministic Trigger-created IDs there for machine access. There is no global session directory. Reading a conversation or changing its model does not expand its persisted Tool grants.

## Models

Set `model` in `server/touka.config.ts` for the default. pi-ai's bundled providers are registered directly; configure their documented server secret names, such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GROQ_API_KEY`. AI Gateway is optional, never an implicit route or fallback.

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

## Machine Webhooks and operations

Use a token and session from `TEAM_AUTH` to start or continue work:

```sh
curl http://localhost:5173/triggers/webhook \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sessionId":"session-id","operationId":"stable-id","input":"Hello"}'
```

The endpoint returns 202 after durable acceptance, without waiting for model completion. Reusing an operation ID preserves its first input and returns `accepted:false`. Queue exhaustion returns 429. All `/api/*` routes require bearer authentication and session routes enforce the caller's allowlist.

| Management route                                | Purpose                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/models`                               | Registered providers and models                                  |
| `GET /api/sessions`                             | Caller-authorized session summaries                              |
| `POST /api/sessions`                            | Create with `{"sessionId":"id"}` and optional `model`            |
| `GET /api/sessions/:id`                         | Model, busy state, pending work                                  |
| `GET /api/sessions/:id/messages`                | Persisted transcript                                             |
| `PUT /api/sessions/:id/model`                   | Select `{"provider":"provider-id","id":"model-id"}`              |
| `POST /api/sessions/:id/abort`                  | Stop with `{}` or `{"operationId":"id"}`                         |
| `POST /api/sessions/:id/retry`                  | Resume parked work                                               |
| `GET /api/sessions/:id/operations/:operationId` | Durable operation status/result                                  |
| `GET /api/sessions/:id/events`                  | Read-only authenticated [WebSocket stream](docs/event-stream.md) |

Operations expose `queued`, `running`, `parked`, `done`, or `unanswered`. Authenticated retry resumes parked tasks; unanswered is terminal and needs a new operation ID after configuration is fixed. Model changes affect the next call, not an in-flight request. Registered tools enforce explicit grants and conservative replay safety; code work stops at PR creation, not merge or deployment.

## Limits

- Input deduplication is not exactly-once external delivery. Model calls or replies can repeat across crash boundaries; inspect external results before retrying ambiguous writes.
- Operation expiry, history deletion, cursor-based event replay, and workspace backups are not implemented. WebSockets reconnect from a fresh snapshot. Sandbox workspaces are ephemeral.
- Real Slack/GitHub/Discord/MCP/LLM connectivity, Docker/Cloudflare Containers, and production deployment require operator setup and have not been verified here.
- Dependency advisories remain tracked in `.r5/issues/remote-agent/07-dependency-advisories.json`. Do not expose development servers publicly or apply breaking `audit fix --force` downgrades.
