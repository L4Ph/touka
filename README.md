# Remote Agent

Independent root Void React Pages SSR and server Pi Durable Workers. M0, the Webhook pilot, and session controls are implemented; event delivery/integrations follow later. Unimplemented routes return 404, not fabricated success.

## Install / verify

Use Node 24, npm, and Cloudflare's `cf` CLI.

```sh
npm ci
npm run verify
```

Preserve Void's default Vite+ toolchain. After the official 1.4.0 migration, 37 runtime tests, builds, delivery verification, and check passed with 0 errors and 44 warnings. That is a migration baseline, not proof for subsequent changes. The root uses `vp -C .`; the server builds independently, with real Node/workerd tests.

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

- `packages/adapter-contract/src/core.ts`: transport-neutral `sessionId / operationId / input`, with no source union or origin prompt. Requests are capped at 32 KiB, input at 16k characters, IDs at 128 characters, pending operations at 16, and registered tools at 32. Webhook pending limits include running work.
- `server/src/session.ts`: real PiHarness, Lifecycle, `onWake`, SQLite, and Pi `~1.4.0`. Provider/model selection is explicit with no fallback. State inspection works without a model but does not imply successful execution. Models come from pi-ai and operator registrations; SDK authContext resolves arbitrary server secret bindings. Missing configuration is never replaced by another provider.
- `packages/adapter-<name>/src/index.ts`: independent npm packages export `create(dependencies): Hono<AdapterAppEnv>` using typed `adapter-contract` capabilities, not server/core internals. They mount at `/adapters/<name>` and export `deliver(context)` for the shared SQLite outbox/alarm. Each authenticates fail-closed, owns signatures, policies, body/thread/reply formats, and calls `dependencies.execute` only after authentication. See [`server/src/README.md`](server/src/README.md); `verify:delivery` covers real HTTP/SQLite/alarms and authorized tools.
- `server/src/tools/<name>/index.ts`: export `create(context: ToolContext): Extension`; the extension name must match its directory. Duplicate extension/tool names or more than 32 tools fail startup, verified against the real registry. Tools are independent of ingress and enforce authorization, output/time limits, and replay classification. Extend Env through module-owned TypeScript declaration merging; shared bindings are wired sequentially during integration.
- M2 owns `packages/adapter-slack/`, `packages/adapter-github/`, `server/src/tools/github/`, and `server/src/tools/sandbox/`. Modules register from their directories without central registry edits. Tests discover directory-local `*.test.ts`; only `index.ts` is automatically registered.
- Tools receive the persisted authenticated principal/resources and logical session ID. Unbound contexts deny all access; implicit authority changes within a session are rejected. Session allowlists alone grant no outbound tool rights. No ambient shell/fetch tools are registered. Unauthorized tools fail rather than returning fabricated success.
- GitHub App/REST/webhook, Slack Web API, and Cloudflare Sandbox dependencies are installed. Sandbox container bindings and provisioning belong to that module.

## Verification evidence / limits

Runtime tests cover real HTTP, DO SQLite, Pi initialization, health, auth/session/upgrade rejection, oversized bodies, and invalid/duplicate auth configuration. Plugin fixtures build real registration code in Vite+ and test routes, tools, context, and missing namespaces. Wrong-glob and empty-Pi mutations fail and were restored. Successful WS/events are not implemented yet. Isolated/reordered/repeated tests and Launch/Doctor/Drive/Cleanup passed. The spine does not call models; the pilot uses an external model fake. No production service credentials or Git remote were available.

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

Status reads Pi's real pending/settled operations: `queued / running / parked / done / unanswered`. Done includes text; unanswered includes a reason. Missing models or credentials never become success. Parked means the crash-restart limit was reached, not successful or infinite retry. Use authenticated retry, stop, and model controls below. Built-in and operator providers never silently fall back.

`server/test/pilot.test.ts` is the vertical-slice example. It runs the built Worker on real Miniflare/workerd, SQLite, and HTTP, faking only external Anthropic SSE. Gated streams prove acceptance, running/queued states, limits, and concurrent dedupe. Reopening the same SQLite verifies recovery and retained results; repeated mid-run restarts exercise Pi's real parked-task guard. Other cases cover missing-model unanswered results and fail-closed auth. No fixed sleeps or test-only production hooks are needed. Rejected requests never reach the model, and model input contains no origin message.

Limits: operation expiry and history deletion are not implemented. Do not reuse accepted IDs in a session. A DO restart may repeat model requests: input dedupe is not exactly-once billing or side-effect delivery. Live LLM, Slack/GitHub, and reply delivery remain unverified.

## Durable session controls

```sh
npm run verify:sessions && npm run typecheck
```

All APIs require TEAM_AUTH bearer auth. Preconfigure session IDs in each principal's allowlist; no dynamic grants. List only existing authorized sessions.

| Method / path                    | Body / result                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /api/models` | Real pi-ai provider/model/API catalog, native/Gateway transport, and configuration status; no secrets |
| `POST /api/sessions` | `{sessionId, model?: {provider, id}}`; 201 on creation, 409 on duplicate |
| `GET /api/sessions`              | `{sessions: [{sessionId, model, busy, pending}]}`                                   |
| `GET /api/sessions/:id` | `{sessionId, model, busy, pending}`; 404 when absent |
| `GET /api/sessions/:id/messages` | `{messages}` containing Pi's active transcript entries |
| `PUT /api/sessions/:id/model` | `{provider, id}` persisted in Pi's agent settings |
| `POST /api/sessions/:id/abort` | `{operationId?: string}`; omit the ID to stop the session; returns `{aborted}` |
| `POST /api/sessions/:id/retry` | Resume parked tasks; returns `{retried}` |

Omitted models use server `MODEL_PROVIDER / MODEL_ID`. Invalid models return 400; missing credentials/defaults return 503 without changing existing state. Changes affect the next model request, not an in-flight call. Persisted Pi settings override environment defaults after restart. Lazy Webhook creation remains supported; an unconfigured model settles unanswered.

`cloudflare-ai-gateway` uses pi-ai's bundled provider/catalog and requires all three server settings: `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_GATEWAY_ID`. It supports `anthropic-messages`, `openai-completions`, and `openai-responses`, not every native API. Other built-ins remain selectable. Register compatible URLs explicitly through operator configuration. No key-registration API/chat command exists, and model bodies reject extra keys. Never paste secrets into chat: ordinary messages are retained.

Authenticated retry resumes parked work. Unanswered operations are terminal and cannot be retried that way; inspect the reason, fix configuration, and submit a new ID. The old ID stays deduplicated. Only explicit server resource grants authorize tools; creating a session grants no ambient rights.

Verification uses real workerd, SQLite, HTTP, and fake external model SSE. It covers actual changed-model requests, transcript/abort persistence, denied sessions, invalid models and injected keys, missing configuration, and authenticated recovery from real parked state. Live native/Gateway connectivity is unverified.

## Operator-configured providers (Gateway optional)

`MODEL_PROVIDER / MODEL_ID` only select defaults. SDK `builtinModels()` registers every bundled provider, so choosing Groq needs no app change. Configure provider-specific secrets as server bindings; `authContext.env(name)` resolves arbitrary own string bindings, not browser or ambient Node values. Missing auth never becomes success; invalid secrets/configuration fail closed. Only the local launcher passes operator process values into Worker bindings. Interactive OAuth, credential files, and dynamic catalog refresh are unsupported.

Compatible endpoint example: server-only `MODEL_PROVIDERS` JSON, typed by `ProviderConfig` in `server/src/provider-config.ts`:

```json
[
  {
    "id": "team-inference",
    "api": "openai-completions",
    "baseUrl": "https://inference.example.test/v1",
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

Set `TEAM_INFERENCE_SECRET` separately, then select `MODEL_PROVIDER=team-inference` and `MODEL_ID=team-chat`. JSON supports lazy SDK implementations of `openai-completions`, `openai-responses`, and `anthropic-messages`; unauthenticated local services require explicit `auth:{keyless:true}`. Base URLs must use HTTP(S) without embedded credentials, query, or fragment. HTTP is only for trusted local paths. Limits are 128 KiB, 32 providers, and 256 models each. Unknown keys, duplicate IDs, or invalid metadata reject the full configuration. JSON compat supports the small documented set of common flags.

Register other APIs, complete metadata/headers/auth, or SDK Provider objects in operator-owned `server/src/operator-providers.ts`. Use native pi-ai `createProvider()` without core changes. Registration order is built-ins, JSON, then the SDK array. Reusing an ID explicitly replaces a provider; it is not error fallback. Operators own endpoint selection; browsers/chat cannot register URLs, APIs, or credentials. The public catalog exposes only provider/model IDs, names, APIs, and configured status, not endpoints/auth/headers. Never put secrets in public names.

```sh
npm run verify:models && npm run verify && npx vp check
```

`verify:models` uses real Node pi-ai to serialize Groq/custom OpenAI-compatible requests, faking only external SSE. It proves Gateway-independent configuration, arbitrary secrets, negative cases, and catalog redaction. Real workerd/SQLite/HTTP tests cover auth, client-configuration rejection, and persisted custom model selection. **Not every built-in transport is guaranteed on workerd.** File/ambient AWS or Google auth, Node-specific transports, and OAuth remain unverified. Catalog/configured status is not connectivity proof. Unsupported transports fail without Gateway conversion or provider rerouting; successful Node serialization is not live LLM evidence.

## Dependency audit

Comparing `npm audit --json` with the original HEAD lockfile found 17 starter advisories (10 moderate, 7 high) and 18 in the current lockfile (9 each), with no critical findings. Existing paths include Void/cf/config/Zod, native image libraries, old esbuild/drizzle, and undici. Miniflare 4 pins vulnerable undici 7.28.0; it is local loopback test tooling, not Worker output. Miniflare 5 needs a separate API migration, not a compatibility shim. Updating undici did not override the pin. Force fix proposes breaking Void downgrades and was not run. Counts can change with registry data. Never expose development servers publicly.

References: Cloudflare [PiHarness](https://developers.cloudflare.com/agents/harnesses/pi/), installed `agents/harness/pi` and Pi 1.4 types, Void's bundled quickstart/CLI docs, and `cf --help`, `cf dev --help`, and `cf build --help`. The independent Worker uses Vite+ with Cloudflare's plugin and preserves the existing Void Wrangler scaffold.
