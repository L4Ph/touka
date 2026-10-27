# Remote Agent

Independent root Void React Pages SSR and server Pi Durable Workers. Only the M0 spine is implemented; model execution, Webhooks, session controls, events, and integrations follow later. Missing routes return 404, not fabricated success.

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

- `shared/contracts.ts`: session/operation/input only, no source labels or origin prompt. Requests: 32 KiB; input: 16k characters; IDs: 128 characters; pending: 16; tools: 32. The acceptance unit will enforce pending limits.
- `server/src/session.ts`: real PiHarness/Lifecycle/onWake/SQLite/Pi ~1.4.0 with explicit models and no fallback. State inspection does not prove model execution. Only server OpenAI/Anthropic keys are supported; do not substitute another provider for missing config.
- `server/src/adapters/<name>/index.ts`: create() returns Hono<AppEnv> and mounts at /adapters/<name>. Each adapter owns signatures, policy, bodies, dedupe, and replies. These are not bearer routes; each must authenticate fail-closed.
- `server/src/tools/<name>/index.ts`: export `create(context: ToolContext): Extension`; the extension name must match its directory. Duplicate extension/tool names or more than 32 tools fail startup, verified against the real registry. Tools are independent of ingress and enforce authorization, output/time limits, and replay classification. Extend Env through module-owned TypeScript declaration merging; shared bindings are wired sequentially during integration.
- M2 owns adapters/slack, adapters/github, tools/github, and tools/sandbox. Directory-owned modules register without central edits; discover *.test.ts locally and register only index.ts.
- Tools receive unbound principals and empty resources until session-control persists ownership/resource policy. No ambient shell/fetch or fabricated success for denied operations.
- GitHub App/REST/webhook, Slack Web API, and Cloudflare Sandbox dependencies are installed. Sandbox container bindings and provisioning belong to that module.

## Verification evidence / limits

Real HTTP/DO SQLite/Pi tests cover health, missing/invalid tokens, denied sessions/upgrades, large bodies, and malformed/mixed/duplicate auth. Isolated Vite-built registry fixtures test module namespaces, tools, and context. Wrong-glob and empty-Pi mutations failed and were restored; WS/event success is not yet implemented. Isolated/reordered/repeated tests and operational lifecycle passed. Neither fake nor live models were called, so model responses are not proven. No production credentials or Git remote were available.

## Dependency audit

Comparing `npm audit --json` with the original HEAD lockfile found 17 starter advisories (10 moderate, 7 high) and 18 in the current lockfile (9 each), with no critical findings. Existing paths include Void/cf/config/Zod, native image libraries, old esbuild/drizzle, and undici. Miniflare 4 pins vulnerable undici 7.28.0; it is local loopback test tooling, not Worker output. Miniflare 5 needs a separate API migration, not a compatibility shim. Updating undici did not override the pin. Force fix proposes breaking Void downgrades and was not run. Counts can change with registry data. Never expose development servers publicly.

References: Cloudflare PiHarness, installed agents/Pi 1.4 types, bundled Void quickstart/CLI docs, and cf help for dev/build. The independent Worker uses Vite's Cloudflare plugin and preserves the existing Void Wrangler scaffold.
