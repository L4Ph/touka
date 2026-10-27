# Remote Agent

## Agreed product scope

A general-purpose remote agent, not a coding-only bot. Pi Durable owns the execution loop, pi-ai owns model access, and the Cloudflare Agents SDK PiHarness/Lifecycle runs it durably in a Durable Object. Slack mentions, GitHub bot mentions, authenticated webhooks and a Web UI can initiate work. Coding workflows stop at pull requests; deployment operations are out of scope. Cloudflare OS is explicitly not a reference implementation or parity target for this mission.

## Architecture decisions

- Preserve the official Void React Pages starter, including its SSR. Do not convert it to an SPA, TanStack Start or HonoX. The user explicitly corrected an unwanted SPA conversion.
- Keep the web client and agent server independently buildable/deployable. Keep the root Void app as the web app; put the agent Worker in `server/`. Do not couple the core to Void page loaders.
- The agent core is transport-agnostic. It accepts session IDs, operation IDs and input. It neither imports Slack/GitHub payload types nor requires a `source` discriminator. Do not inject origin labels into model prompts.
- Adapters own inbound signatures, allowed actors/resources, mention filtering, external thread-to-session mapping, duplicate delivery IDs and outbound reply delivery. Web UI is another client of the same core API.
- Keep inbound GitHub adapter separate from outbound GitHub tools: a web-started conversation may create a PR using the existing bot GitHub App.
- HTTP/Hono typed API is the control plane; authenticated DO WebSockets carry snapshots and execution events. Reconnection obtains a fresh snapshot, not a fictitious cursor replay.
- One Durable Object/root Pi conversation per session. Operation IDs survive client/provider retries. Use durable acceptance before acknowledging external events; do not run long model work inside the webhook response.
- Provider/model defaults come from server environment; explicit authenticated session commands can change and persist them. Credentials stay in server secrets, not chat text/browser storage. pi-ai native providers and Cloudflare AI Gateway have different support; no silent fallback.
- Target a private team with workspace/repository/actor allowlists, not public SaaS signup. Authentication fails closed when configuration is missing. Origin metadata may exist in adapter audit records, not in the core input schema.
- Side-effecting tools must enforce authorization outside the model and declare replay safety honestly. No arbitrary internet-fetch or host-shell tool with ambient credentials. A sandbox is the only place for generated executable code.

## Delivery

Mission plan: `docs/mission.md`. Local tickets: `.r5/issues/`. Runtime task ledger: `.r5/ledger.jsonl` (not committed). All repository documentation, comments, issues, code, model prompts, and commit messages use English. Conversation follows the user's language. Preserve the initialized scaffold unless a feature requires a change; add no speculative OS/gadget abstractions.

## Primary sources

- https://developers.cloudflare.com/agents/harnesses/pi/
- https://developers.cloudflare.com/agents/models/pi-ai/
- https://developers.cloudflare.com/agents/examples/slack-agent/
- https://developers.cloudflare.com/agents/examples/chat-agent/
- https://void.cloud/guide/

PiHarness is beta; inspect current installed source/types. The Chat Agent tutorial uses AIChatAgent/Vercel AI SDK and is not a drop-in PiHarness client. Use Pi's own event streams rather than adding a second agent loop. Void documentation is bundled in `node_modules/void/docs/`.
