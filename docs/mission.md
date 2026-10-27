# Remote Agent initial release

## Completion criteria

Implement the initial ten units and shared delivery spine, then pass scoped tests, type checks, builds, and local HTTP/WS verification. Use real credentials only when available and never label unverified service behavior as success. Without a Git remote, committed local tickets are the issue tracker.

## Milestones

| Unit | Milestone | Deliverables and acceptance |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| spine | M0 | Independent server Worker, shared types, Pi dependencies, fail-closed auth, and test/type/build/runtime scripts; preserve the Void starter |
| webhook-pilot | M0 | Authenticated durable submission, dedupe, and status; first real-HTTP vertical slice with negative cases |
| session-control | M1 | Session creation/list/history/status/stop/model controls; persistence, recovery, and visible parked/unanswered states |
| event-stream | M1 | Authenticated session-scoped DO WebSockets: snapshots, events, reconnect, unsubscribe, and limits |
| adapter-delivery-spine | M2 shared prerequisite | Workspace contracts/discovery, authenticated execution, SQLite reply outbox/alarms, persisted tool grants, bindings, historical fixtures, and runtime proof |
| slack-adapter | M2 | Signature/time/policy checks, mention-to-thread mapping, bot filtering, durable ACK, replies, and retries |
| github-adapter | M2 | App webhook signature/repository/actor/mention checks, Issue/PR mapping, self-reply filtering, delivery, and retry dedupe |
| github-tools | M2 | Scoped short-lived App tokens for file reads, branches/files, and PR creation; no merge/deploy; honest replay policy |
| sandbox-tools | M2 | Isolated general-purpose code execution and file IO, separated secrets/host execution, limits, stop, and failure coverage |
| web-client | M3 | Void React chat with sessions/history/running/stop/models/reconnect/errors/empty states as a common core API client |
| integration-proof | M4 | Wiring, setup, Launch/Doctor/Drive/Evidence/Cleanup, security negatives, full verification, and operations documentation |

Implement M0 sequentially and use the Webhook pilot as the exemplar. Parallelize only disjoint owned files; shared contracts and integration remain sequential.

## M2 shared-spine corrections and resume prerequisites

`create() -> Hono` alone cannot register durable reply jobs. Fix the shared spine rather than asking for a product decision. `server/src/README.md` defines the M2 contracts and exemplar.

- Put inbound adapters in independent `packages/adapter-{webhook,slack,github}` workspaces. Import only shared `adapter-contract`, not server internals. The server discovers exports and supplies typed dependencies and durable bindings. Delete old `server/src/adapters` and duplicate proxy/job implementations.
- Shared `AdapterDependencies.execute` and SQLite/alarm `AdapterJobs` own acceptance and the reply outbox. Discover package `deliver` exports without central edits. Keep reply/origin metadata only in the outbox, never Pi input.
- Persist the authenticated principal/session/resource grant and pass logical session IDs to real tools. Reject implicit authority changes with 403 and use a new session. Never attach authority retroactively to unbound/unauthenticated input.
- **Slack resume:** Existing code/tests moved to `packages/adapter-slack` and shared execution/delivery under server policy grants. Use `slack-cloudflare-workers` verification and awaited `beforeAuthorize` for durable ACK, not automatic event ACK or lazy waitUntil. Remove the private job Worker/binding and finish vendor rate/size/protocol policy.
- **GitHub resume:** `packages/adapter-github` is an unimplemented skeleton. Add exports, types, tests, create/dependencies, and delivery. It owns signatures, actors/repos/mentions, and thread mapping. Inject shared App auth through contracts; reply with `github.token(repo, 'reply')`. Never duplicate JWT/token logic. Retry 429/5xx and expose permanent failures.
- **GitHub Tools resume:** Shared work fixed unbound grants and historical fixtures. Replace unsupported Workers `redirect:error` with manual/non-2xx rejection and test real registered tools on workerd. Preserve authorization and side-effect policy.
- **Sandbox resume:** Shared work supplies SANDBOX binding/export/migration/Env. Follow the module README for real image provisioning; do not claim unverified Docker/production Containers work.
- **All M2 workers:** Derive historical glob membership from M0's `git ls-tree`, not current directories. Retain the real old-to-current SQLite/history/model/WS upgrade regression in scoped verification.
- **Delivery regressions:** Restart real SQLite during unresolved reply sends and queued Pi work before tool execution, without resubmitting grants. Preserve the 20-second timeout and structured failures. Also verify the Slack library cannot ACK success without an outbox.
- **Integration prerequisites:** Enforce vendor payload/output and ingress-rate limits plus authenticated status. Document at-least-once crash duplicates, 6 attempts/24 hours, one-hour maximum 429 delay, 100 retained jobs/session, and snapshot-grant revocation limits. Real service connectivity/deployment needs credentials and permission.

Shared verification: `npx vp check && npm run verify:delivery && npm run verify`. Preserve Void's Vite+ toolchain. The migration baseline passed 37 tests/builds plus delivery/check with 0 errors and 44 warnings; recheck later changes independently. Evidence is local HTTP/SQLite/alarms with external fakes, not live LLM/vendor connectivity.

## Operator provider correction

Do not restrict models to Anthropic/OpenAI/Gateway. Register pi-ai built-ins, server-only MODEL_PROVIDERS JSON, and the typed Provider array in operator-providers.ts. JSON handles common APIs/endpoints/metadata/arbitrary secret names or explicit keyless auth; native createProvider handles other SDK capabilities. Authenticated clients select registered models only; operators own endpoints/credentials. Defaults are MODEL_PROVIDER/MODEL_ID; selections persist in Pi SQLite. No mandatory Gateway, implicit reroute, or fallback.

`verify:models` exercises real Groq/custom request serialization with only external HTTP faked, arbitrary auth, negative configuration, catalog redaction, and real workerd/SQLite selection persistence/client rejection. It does not prove every SDK transport works on workerd or live connectivity. See README for file/ambient auth, OAuth, and transport limits. Preserve Vite+ 1.4.0 and unfinished adapter/delivery work. Final gate: `npm run verify:models && npm run verify && npx vp check`.

## Additional unit: shared-web-chat-auth

Implement Better Auth and shared discovery before the Web UI. Connect independent root Void SSR/core Workers through AGENT_CORE and the named WebGateway. Supply auth/D1 migrations, cookie proxy `/api/agent/*`, typed client, revocable WebSockets, and a shared durable directory while leaving the starter UI for web-client. Team members share one DO and its controls; tool grants remain server-owned.

Run `npm run verify:auth && npm run verify && npx vp check`. Use real local Better Auth callbacks, D1, workerd, SQLite, HTTP, and WebSockets to cover two-user history, anonymous/origin/membership rejection, disabled signup, forged headers, unchanged grants, machine backfill, new adapter discovery, restart, logout, and revocation. Fake only OAuth/Slack/model boundaries. Seed older unindexed IDs explicitly because DO enumeration is impossible. See [shared web auth](shared-web-auth.md) for setup, five-second idle revocation, and limits.

## Security and data

- Reject unknown workspaces/repos/actors, anonymous HTTP/WS, invalid signatures, and oversized payloads before execution.
- Separate ingress from tools. Inputs require no origin discriminator; server code validates authenticated principals and grants.
- Track input idempotency separately from external reply delivery. Do not claim exactly-once external APIs; document crash and retry boundaries.
- Keep model keys, GitHub App private keys, and Slack tokens out of browsers, conversations, and logs.
- Restrict reads and writes to authorized resources; grant writes explicitly. No deployment or merge operations.
- Bound model loops and ingress queues; expose limits, failure reasons, and recovery paths.

## UI and operations

Provide keyboard access, labels, and accessible status announcements. Distinguish empty/sending/running/stopped/failed/disconnected/reconnecting states and reuse operation IDs for retries. APIs return structured errors; logs primarily contain IDs/status. Doctor is read-only.

## Out of scope

Cloudflare OS/Gadgets, public multi-tenant SaaS, deployment, PR merge, browser/chat credential or arbitrary endpoint registration, unsupported Pi conversation deletion, and cursor event replay. Track future work separately.

## Verification limits

Fake external LLM/service boundaries locally, but exercise real DO storage, HTTP, and WebSockets. Distinguish credential-free local results from production connectivity. Investigate dependency advisories without unsafe force fixes.
