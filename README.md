# Remote Agent

Independent root Void React Pages SSR and server Pi Durable Workers. M0, the Webhook pilot, and session controls are implemented; event delivery/integrations follow later. Unimplemented routes return 404, not fabricated success.

## Install / verify

Use Node 24, npm, and Cloudflare's `cf` CLI.

```sh
npm ci
npm run verify
```

`verify` runs server type checks, Oxlint, the Worker build, contract tests, real workerd/SQLite/HTTP smoke tests, and the Void SSR build within 120 seconds. Build the server before `npm test`. Root dev/build scripts target the UI; `npm run dev -w server` or `cd server && cf dev` targets the independent Worker. No deployment has been performed.

## Local Launch / Doctor / Drive / Cleanup

Configure server secrets from env.example. TEAM_AUTH contains member IDs, random tokens of at least 32 characters, allowed sessions, and resources. Missing/invalid configuration returns 503, invalid tokens 401, and denied sessions 403. Never embed shared server tokens in browsers; authenticated Web credential handling belongs to web-client.

```sh
npm run build:server
npm run launch -w server   # Foreground on localhost:8787; run the next commands in another terminal.
npm run doctor -w server   # Read-only health check.
# Set AGENT_TOKEN and AGENT_SESSION first.
npm run drive -w server    # Check anonymous rejection and the authorized session's real Pi root.
npm run cleanup -w server  # Stop only the managed process; preserve durable data.
```

Launch runs the built Worker in Miniflare and keeps local DO data in `server/.runtime/state`. Ctrl-C also cleans up the process. `/health` reports liveness, not credential or external-service readiness. The runtime endpoint opens real PiHarness/Lifecycle state and reports root conversation `1` and configuration status. The URL session ID names a DO, not Pi's internal conversation. Doctor creates no DO; Drive initializes one.

## Shared seams / ownership

- `shared/contracts.ts`: session/operation/input only, with no source union or origin prompt. Requests: 32 KiB; input: 16k characters; IDs: 128 characters; pending: 16 including running work; tools: 32.
- `server/src/session.ts`: real PiHarness/Lifecycle/onWake/SQLite and Pi ~1.4.0 with explicit provider/model and no fallback. State inspection without a model does not prove execution. Auth supports server OpenAI/Anthropic/Cloudflare Gateway configuration only; never replace missing config with another provider.
- `server/src/adapters/<name>/index.ts`: create() returns Hono<AppEnv> and mounts at /adapters/<name>. Each adapter owns signatures, policy, bodies, dedupe, and replies. These are not bearer routes; each must authenticate fail-closed.
- `server/src/tools/<name>/index.ts`: export `create(context: ToolContext): Extension`; the extension name must match its directory. Duplicate extension/tool names or more than 32 tools fail startup, verified against the real registry. Tools are independent of ingress and enforce authorization, output/time limits, and replay classification. Extend Env through module-owned TypeScript declaration merging; shared bindings are wired sequentially during integration.
- M2 owns adapters/slack, adapters/github, tools/github, and tools/sandbox. Directory-owned modules register without central edits; discover *.test.ts locally and register only index.ts.
- Tools currently receive unbound principals with no resources. Session allowlists are not outbound authority; grant nothing until per-tool policy exists. Do not register ambient shell/fetch or fabricate successful unauthorized results.
- GitHub App/REST/webhook, Slack Web API, and Cloudflare Sandbox dependencies are installed. Sandbox container bindings and provisioning belong to that module.

## Verification evidence / limits

Runtime tests cover real HTTP, DO SQLite, Pi initialization, health, auth/session/upgrade rejection, oversized bodies, and invalid/duplicate auth configuration. Plugin fixtures build real registration code in Vite and test routes, tools, context, and missing namespaces. Wrong-glob and empty-Pi mutations fail and were restored. Successful WS/events are not implemented yet. Isolated/reordered/repeated tests and Launch/Doctor/Drive/Cleanup passed. The spine does not call models; the pilot uses an external model fake. No production service credentials or Git remote were available.

## Webhook pilot / verification example

```sh
npm run verify:pilot
npm run typecheck
# Against a running Worker, AGENT_TOKEN must authorize the target session.
curl -sS http://127.0.0.1:8787/adapters/webhook \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sessionId":"session-id","operationId":"stable-delivery-id","input":"Hello"}'
curl -sS http://127.0.0.1:8787/api/sessions/session-id/operations/stable-delivery-id \
  -H "Authorization: Bearer $AGENT_TOKEN"
```

`POST /adapters/webhook` accepts only `sessionId / operationId / input`, normalizes newlines to LF, and trims surrounding whitespace. TEAM_AUTH authorizes the session. After durable Pi SQLite acceptance it returns 202 with `{sessionId, operationId, accepted}` without waiting for the model. Retrying an ID preserves the first input and returns `accepted:false`, even when the inbox is full; new inputs then return 429. IDs use letters, digits, `_`, or `-`, up to 128 characters. Oversized bodies return 413, invalid input 400, unauthorized sessions 403, and unknown operations 404.

Status reads real Pi pending/settled operations: queued/running/parked/done/unanswered, with text or reason. Missing models/auth never become success. Parked indicates restart exhaustion, not infinite retry. Authenticated controls are listed below. Register Anthropic/OpenAI/Cloudflare Gateway explicitly without fallback.

`server/test/pilot.test.ts` is the vertical-slice example. It runs the built Worker on real Miniflare/workerd, SQLite, and HTTP, faking only external Anthropic SSE. Gated streams prove acceptance, running/queued states, limits, and concurrent dedupe. Reopening the same SQLite verifies recovery and retained results; repeated mid-run restarts exercise Pi's real parked-task guard. Other cases cover missing-model unanswered results and fail-closed auth. No fixed sleeps or test-only production hooks are needed. Rejected requests never reach the model, and model input contains no origin message.

Limits: operation expiry and history deletion are not implemented. Do not reuse accepted IDs in a session. A DO restart may repeat model requests: input dedupe is not exactly-once billing or side-effect delivery. Live LLM, Slack/GitHub, and reply delivery remain unverified.

## Durable session controls

```sh
npm run verify:sessions && npm run typecheck
```

All APIs require TEAM_AUTH bearer auth. Preconfigure session IDs in each principal's allowlist; no dynamic grants. List only existing authorized sessions.

| Method / path | Body / result |
|---|---|
| `GET /api/models` | Real pi-ai provider/model/API catalog, native/Gateway transport, and configuration status; no secrets |
| `POST /api/sessions` | `{sessionId, model?: {provider, id}}`; 201 on creation, 409 on duplicate |
| `GET /api/sessions` | `{sessions: [{sessionId, model, busy, pending}]}` |
| `GET /api/sessions/:id` | `{sessionId, model, busy, pending}`; 404 when absent |
| `GET /api/sessions/:id/messages` | `{messages}` containing Pi's active transcript entries |
| `PUT /api/sessions/:id/model` | `{provider, id}` persisted in Pi's agent settings |
| `POST /api/sessions/:id/abort` | `{operationId?: string}`; omit the ID to stop the session; returns `{aborted}` |
| `POST /api/sessions/:id/retry` | Resume parked tasks; returns `{retried}` |

Omitted models use server `MODEL_PROVIDER / MODEL_ID`. Invalid models return 400; missing credentials/defaults return 503 without changing existing state. Changes affect the next model request, not an in-flight call. Persisted Pi settings override environment defaults after restart. Lazy Webhook creation remains supported; an unconfigured model settles unanswered.

The bundled cloudflare-ai-gateway catalog/provider requires CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID, and CLOUDFLARE_GATEWAY_ID. It supports anthropic-messages/openai-completions/openai-responses, not all native APIs. Workers AI and arbitrary URLs are not auto-registered. No credential API/chat command exists; reject extra model keys. Never paste secrets into retained conversations.

Authenticated retry resumes parked work. Unanswered is terminal: inspect the reason, fix configuration, and submit a new ID; old IDs dedupe. Tools remain deny-all; session creation grants no ambient authority.

Verification uses real workerd, SQLite, HTTP, and fake external model SSE. It covers actual changed-model requests, transcript/abort persistence, denied sessions, invalid models and injected keys, missing configuration, and authenticated recovery from real parked state. Live native/Gateway connectivity is unverified.

## Dependency audit

Comparing `npm audit --json` with the original HEAD lockfile found 17 starter advisories (10 moderate, 7 high) and 18 in the current lockfile (9 each), with no critical findings. Existing paths include Void/cf/config/Zod, native image libraries, old esbuild/drizzle, and undici. Miniflare 4 pins vulnerable undici 7.28.0; it is local loopback test tooling, not Worker output. Miniflare 5 needs a separate API migration, not a compatibility shim. Updating undici did not override the pin. Force fix proposes breaking Void downgrades and was not run. Counts can change with registry data. Never expose development servers publicly.

References: Cloudflare PiHarness, installed agents/Pi 1.4 types, bundled Void quickstart/CLI docs, and cf help for dev/build. The independent Worker uses Vite's Cloudflare plugin and preserves the existing Void Wrangler scaffold.
