# Remote Agent initial release

## Completion criteria

Implement the ten units below and pass scoped tests, types, builds, and local HTTP/WS verification. Use real credentials only when available; never report unverified services as success. Without a Git remote, committed local tickets are the issue tracker.

## Milestones

| Unit | Milestone | Deliverables and acceptance |
|---|---|---|
| spine | M0 | Independent server Worker, shared types, Pi dependencies, fail-closed auth, and test/type/build/runtime scripts; preserve the Void starter |
| webhook-pilot | M0 | Authenticated durable submission, dedupe, and status; first real-HTTP vertical slice with negative cases |
| session-control | M1 | Session creation/list/history/status/stop/model controls; persistence, recovery, and visible parked/unanswered states |
| event-stream | M1 | Authenticated session-scoped DO WebSockets: snapshots, events, reconnect, unsubscribe, and limits |
| slack-adapter | M2 | Signature/time/policy checks, mention-to-thread mapping, bot filtering, durable ACK, replies, and retries |
| github-adapter | M2 | App webhook signature/repository/actor/mention checks, Issue/PR mapping, self-reply filtering, delivery, and retry dedupe |
| github-tools | M2 | Scoped short-lived App tokens for file reads, branches/files, and PR creation; no merge/deploy; honest replay policy |
| sandbox-tools | M2 | Isolated general-purpose code execution and file IO, separated secrets/host execution, limits, stop, and failure coverage |
| web-client | M3 | Void React chat with sessions/history/running/stop/models/reconnect/errors/empty states as a common core API client |
| integration-proof | M4 | Wiring, setup, Launch/Doctor/Drive/Evidence/Cleanup, security negatives, full verification, and operations documentation |

Implement M0 sequentially and use the Webhook pilot as the exemplar. Parallelize only disjoint owned files; shared contracts and integration remain sequential.

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

Cloudflare OS/Gadgets, public SaaS, deployments, PR merge, dynamic credentials for every provider, unsupported Pi conversation deletion, and cursor replay are out of scope. Track future requirements separately.

## Verification limits

Fake external LLM/service boundaries locally, but exercise real DO storage, HTTP, and WebSockets. Distinguish credential-free local results from production connectivity. Investigate dependency advisories without unsafe force fixes.
