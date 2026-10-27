# Slack inbound adapter

Independent npm workspace package. `src/index.ts` exports `create` and `deliver`; server composition mounts `/adapters/slack` and registers the shared SQLite/alarm outbox. No server/core imports, separate proxy worker, service binding or Slack-specific job engine.

## Server-only configuration

- `SLACK_SIGNING_SECRET`: app signing secret.
- `SLACK_ADMIN_TOKEN`: strong independent operator credential for delivery status.
- `SLACK_WORKSPACES`: secret JSON array of `{id, actors, botUserId, token, resources?}`. Workspace and human actor must match. `resources` defaults to empty (no tools); only server configuration grants resources, e.g. `github:owner/repo:read`. Workspace identity owns a shared thread conversation. Tokens must never enter the Void client, prompts or logs.

Signed app mentions map workspace/channel/thread deterministically to a session. Bot/subtype/self events are ignored. Input contains only mention-stripped text, with normalized line endings. Source metadata is stored only in the outbox reply destination. Duplicate identical deliveries return `accepted:false`; conflicting reused IDs are rejected rather than replacing input.

## ACK contract

Uses `slack-cloudflare-workers` (re-exporting `slack-edge`). Upstream `docs/simple_app.md` uses `SlackApp.event`, whose generated ACK does **not** await its lazy listener, even with `startLazyListenerAfterAck:false` (it calls `waitUntil`). We instead use supported `SlackApp.beforeAuthorize` middleware: signature verification and built-in URL verification run first, then our awaited middleware filters/authenticates/maps and **awaits durable execute before returning the ACK**. No lazy/model work or `waitUntil` is used. An acceptance failure propagates a non-2xx response.

Ingress is bounded to 32 KiB before library parsing. Timestamp and signature syntax guards additionally reject future timestamps/malformed prefixes; the library performs the HMAC verification. Delivery uses fixed Slack endpoints with the shared abort deadline, 429 Retry-After, bounded retry/backoff and structured permanent failures. Results are truncated to 3900 characters and sent in the original thread, with markdown/unfurls disabled.

Status: `GET /adapters/slack/jobs/:team/:channel/:thread/:operation`, bearer `SLACK_ADMIN_TOKEN`. Returns sanitized shared outbox state, attempts, due and failure; never input, reply text or credentials. See `../../server/src/README.md` for shared limits, acceptance-time grant revocation limits and at-least-once duplicate risk.

`npm test --workspace @remote-agent/adapter-slack` drives actual local workerd/SQLite, real signatures, delayed fake model, durable ACK, dedupe, reopen, 429 and permanent failures. No live Slack/LLM evidence or deployment. Resumed Slack unit should review vendor-specific limits/rate gates and expand its protocol policy without changing the shared core.
