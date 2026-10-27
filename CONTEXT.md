# Remote Agent

## Agreed product scope

A general-purpose remote agent, not a coding-only bot. Pi Durable owns the execution loop, pi-ai owns model access, and the Cloudflare Agents SDK PiHarness/Lifecycle runs it durably in a Durable Object. Slack mentions, GitHub bot mentions, Discord interactions, authenticated webhooks and a Web UI can initiate work. Coding workflows stop at pull requests; deployment operations are out of scope. Cloudflare OS is explicitly not a reference implementation or parity target for this mission.

## Architecture decisions

- Preserve the official Void React Pages starter, including its SSR and default Vite+ toolchain. Do not convert it to an SPA, TanStack Start or HonoX. The user explicitly corrected an unwanted SPA conversion and the unrequested plain-Vite toolchain selection. Use Vite+ commands for dev/build/lint/format, preserving the real-runtime Node test runner. Root workspace commands use explicit `vp -C .` selection. Official `vp migrate` 1.4.0 is already applied; preserve Vite aliases/overrides and lazyPlugins (the pre-provider-change baseline passed 37 runtime tests and build).
- Keep the web client and agent server independently buildable/deployable. Keep the root Void app as the web app; put the agent Worker in `server/`. Do not couple the core to Void page loaders.
- The agent core is transport-agnostic. It accepts session IDs, operation IDs and input. It neither imports Slack/GitHub payload types nor requires a `source` discriminator. Do not inject origin labels into model prompts.
- Adapters are independent workspace packages under `packages/adapter-slack`, `packages/adapter-github`, `packages/adapter-discord`, and `packages/adapter-webhook`, not server-internal directories. They own inbound signatures, allowed actors/resources, mention filtering, external thread-to-session mapping, duplicate delivery IDs and outbound reply delivery. Server code is the composition root. Web UI is another client of the same core API.
- Use `slack-cloudflare-workers` for Slack protocol and API handling rather than hand-rolling its equivalents. Verify its automatic ACK/lazy listener behavior: durable acceptance must precede successful acknowledgement; model work and reply retries stay in durable jobs, not an ephemeral lazy handler.
- Keep inbound GitHub adapter separate from outbound GitHub tools: a web-started conversation may create a PR using the existing bot GitHub App.
- HTTP/Hono typed API is the control plane; authenticated DO WebSockets carry snapshots and execution events. Reconnection obtains a fresh snapshot, not a fictitious cursor replay.
- One Durable Object/root Pi conversation per session. Operation IDs survive client/provider retries. Use durable acceptance before acknowledging external events; do not run long model work inside the webhook response.
- Provider/model defaults come from operator server configuration; explicit authenticated session commands can select and persist any registered provider/model. Support pi-ai's provider registry and operator-defined custom providers/endpoints, not a hard-coded Anthropic/OpenAI/Gateway allowlist. AI Gateway is optional, never mandatory or an implicit routing layer. Credentials stay in server secrets, not chat text/browser storage. Resolve configured provider auth through pi-ai rather than a fixed list of secret names. Runtime-incompatible provider features must fail explicitly; no silent fallback. `server/src/models.ts` uses pi-ai `builtinModels()` plus server-only `MODEL_PROVIDERS` JSON (`ProviderConfig`) and the typed SDK `Provider[]` seam in `server/src/operator-providers.ts`. JSON supports three common compatible APIs; arbitrary SDK APIs/auth/metadata use native `createProvider()` in that operator module, without editing core. `authContext.env` resolves arbitrary own string Worker bindings; no fixed secret allowlist or ambient process/file credential lookup. Catalog exposes IDs/names/APIs/configured only. `verify:models` proves Node pi-ai HTTP serialization for Groq/custom endpoints and real workerd selection persistence, not universal workerd transport compatibility or live LLM connectivity.
- Target a private team with workspace/repository/guild/actor allowlists, not public SaaS signup. Web authentication uses Better Auth (prefer Void's existing integration rather than inventing browser bearer auth). Every authenticated team member can see all chats, including adapter-started threads. Do not confuse shared chat visibility with external-resource/tool authority. Unauthenticated users see no chat data. Authentication fails closed when configuration is missing. Origin metadata may exist in adapter audit records, not in the core input schema.
- One thread maps to one Session DO/root Pi conversation, independent of the viewing user. A durable shared session index supports all-team discovery; do not provision one copy of a conversation per viewer. Application auth, session listing, and durable reply delivery may have separate infrastructure DOs: one-thread-one-DO is about conversation ownership, not a prohibition on infrastructure objects.
- Discord uses discord-hono in its own adapter package, initially HTTP Interactions (slash command carrying task input) with durable accept before deferred ACK and durable response delivery. Raw mention MESSAGE_CREATE events require a Gateway consumer and are not implied by HTTP Interactions support.
- Side-effecting tools must enforce authorization outside the model and declare replay safety honestly. No arbitrary internet-fetch or host-shell tool with ambient credentials. A sandbox is the only place for generated executable code.

## Shared delivery verification boundary

Workspace migration is present: the server discovers independent package exports, Slack uses the library's awaited `beforeAuthorize` middleware, and the GitHub adapter remains an unimplemented package skeleton for its resumed unit. `verify:delivery` exercises actual workerd/SQLite restart during a pending vendor send and before a queued tool executes, without resubmitting its authorization grant. The non-resolving reply boundary uses the real 20-second deadline. External model/GitHub/reply services are fakes; no deployment or live-service evidence is claimed. A shared gate exposed cross-session snapshot-size calibration drift from generation timing metadata; exact UTF-8 limit checks now exercise the production encoder deterministically, while real WebSocket tests retain near-limit delivery and oversized snapshot/event closure. The exact-limit test rejects a `>=` mutation. The old interrupted fixture is absent; each current fixture is isolated and cleaned by its owning test.

## Delivery

Mission plan: `docs/mission.md`. Local tickets: `.r5/issues/`. Runtime task ledger: `.r5/ledger.jsonl` (not committed). All repository documentation, comments, issues, code, model prompts, and commit messages use English. Conversation follows the user's language. Preserve the initialized scaffold unless a feature requires a change; add no speculative OS/gadget abstractions.

## Primary sources

- https://developers.cloudflare.com/agents/harnesses/pi/
- https://developers.cloudflare.com/agents/models/pi-ai/
- https://developers.cloudflare.com/agents/examples/slack-agent/
- https://developers.cloudflare.com/agents/examples/chat-agent/
- https://void.cloud/guide/

PiHarness is beta; inspect current installed source/types. The Chat Agent tutorial uses AIChatAgent/Vercel AI SDK and is not a drop-in PiHarness client. Use Pi's own event streams rather than adding a second agent loop. Void documentation is bundled in `node_modules/void/docs/`.
