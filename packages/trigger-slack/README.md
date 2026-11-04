# Slack inbound trigger

Independent npm workspace package. `src/index.ts` exports `create` and `deliver`; server composition mounts `/triggers/slack` and registers the shared Queue-backed outbox. No server/core imports, separate proxy worker, service binding or Slack-specific job engine.

## Thread controls

In an existing Touka thread, any permitted human can send:

- `!status`: read Pi's live-state projection without calling a model or waiting for the active tool. Includes tool names and retry/compaction phases, never raw reasoning, tool output, arguments, or provider errors.
- `!stop`: durably capture pending operation IDs and cancel them through the Queue. Confirmation follows cancellation, not merely acceptance. Completed external changes are not undone.
- `!continue`: submit Pi's native continuation after a failed/stopped run without adding a fake user message. Busy conversations receive an explanation instead.
- `!steer <instruction>`: use Pi's native steering inbox for active work. Idle conversations receive an explanation; empty steering is ignored.

Controls bypass the follow-up classifier but retain signature, workspace, human, and session checks. Replies use the durable delivery ledger. While captured operations still await cancellation, new work is declined so it cannot join the run being stopped; status remains available. The fence releases when those operations settle, or with the delivery record's 24-hour lifetime if infrastructure cannot complete cancellation. The delivery-status API exposes persisted state and vendor failures; a pending stop is not proof of cancellation.

Automatic progress uses one separate message per operation, updated at most once a minute. Progress delivery failures never consume final-answer attempts; final answers use a separate message so stale progress cannot overwrite them. General natural-language side conversations and restart/rate-limit verification remain open in `remote-agent/12` and `devin-parity/02`.

## Server-only configuration

- `SLACK_SIGNING_SECRET`: app signing secret.
- `SLACK_ADMIN_TOKEN`: strong independent operator credential for delivery status.
- `SLACK_WORKSPACES`: secret JSON array of `{id, actors, botUserId, token, resources?}`. Workspace must match. Set `actors: "*"` to accept every human sender in that workspace, or use an explicit user-ID array to restrict access. Bot/self events remain ignored, and workspace-wide access does not expand resource grants. `resources` defaults to empty (no tools); only server configuration grants resources, e.g. `github:owner/repo:read`. Workspace identity owns a shared thread conversation. Tokens must never enter model prompts, API responses, or logs.

Signed app mentions map workspace/channel/thread deterministically to a session. Bot/subtype/self events are ignored. Input contains only mention-stripped text, with normalized line endings. Source metadata is stored only in the outbox reply destination. Duplicate identical deliveries return `accepted:false`; conflicting reused IDs are rejected rather than replacing input.

## Creating the Slack App

`manifest.json` declares the bot (`app_mentions:read`, `chat:write`, the `app_mention` event). Run the Slack CLI from this directory; `.slack/hooks.json` reads the manifest through `sed`, so the Worker URL is an environment variable instead of an edit:

```sh
TOUKA_URL=https://<worker> slack install -w <team>
```

**Display name.** The manifest's `bot_user.display_name` only takes ASCII (Slack rejects anything else with `bad_username`), so a non-ASCII display name such as `橙夏` can only be set in the app's App Home page. `slack manifest sync` and `slack install` push the manifest's `touka` over it: set the display name again after either command. Neither command needs the app to be reinstalled just for a name change.

Without `TOUKA_URL` the placeholder `https://touka.example.invalid` is sent, which Slack accepts at creation but cannot verify. Run the same command again after deploying to update the Request URL. The bot token and signing secret are read from the App page; the CLI does not print them.

## Threads without a mention

Besides `app_mention`, the app subscribes to `message.channels` and `message.groups` and needs the `channels:history` and `groups:history` scopes (adding scopes means reinstalling the app). Slack delivers these over the same HTTP Request URL as every other event; Socket Mode is not needed.

- A mention in a thread is answered as before, with the people's messages since the agent last replied added in front (the whole thread when it has not spoken yet). History is context, so an unreadable thread is treated as empty rather than refused.
- Except for the explicit controls above, a message in a thread **without** a mention is answered only when the agent already has a conversation for that thread, the sender is permitted by `actors` (including `"*"`), and a small classifier (`followUp` in `server/touka.config.ts`) judges the message to be meant for the agent. Anything else is acknowledged and ignored. A classifier failure counts as "not meant for the agent".
- The mention itself also arrives as a message event; that copy is ignored so a mention is never handled twice.

## ACK contract

Uses `slack-cloudflare-workers` (re-exporting `slack-edge`). Upstream `docs/simple_app.md` uses `SlackApp.event`, whose generated ACK does **not** await its lazy listener, even with `startLazyListenerAfterAck:false` (it calls `waitUntil`). We instead use supported `SlackApp.beforeAuthorize` middleware: signature verification and built-in URL verification run first, then our awaited middleware filters/authenticates/maps and **awaits durable execute before returning the ACK**. No lazy/model work or `waitUntil` is used. An acceptance failure propagates a non-2xx response.

Legacy form `ssl_check=1` plus `token` patterns are rejected even when embedded in JSON: the library otherwise auto-ACKs that path before signature checks and middleware. This intentionally refuses those rare text bodies rather than falsely acknowledging an unpersisted event; the ordinary signed JSON URL challenge remains supported. The regression was observed returning 200 before the guard.

Ingress is bounded to 32 KiB before library parsing. Timestamp and signature syntax guards additionally reject future timestamps/malformed prefixes; the library performs the HMAC verification. Delivery uses fixed Slack endpoints with the shared abort deadline, 429 Retry-After, bounded retry/backoff and structured permanent failures. Final answers use Slack's official `markdown` block, which Slack translates into native rich text, headings, code, lists, and tables. Complete top-level text provides the notification/screen-reader fallback; automatic link/mention expansion and unfurls are disabled. Explicit Slack mention tokens still have Slack's native meaning. The block limit is 12,000 characters; oversized answers include an explicit truncation notice. Progress remains plain text. GitHub and Discord retain their own Markdown dialects; Slack-specific formatting never enters the shared agent result.

Status: `GET /triggers/slack/jobs/:team/:channel/:thread/:operation`, bearer `SLACK_ADMIN_TOKEN`. Returns sanitized shared outbox state, attempts, due and failure; never input, reply text or credentials. See `../../server/src/README.md` for shared limits, acceptance-time grant revocation limits and at-least-once duplicate risk.

In-source tests (`vp test trigger-slack`) cover real signatures, the thread follow-up decision, thread context, status emoji and the reply swap, with Slack and the classifier faked at the boundary. Local workerd verification exercised signed controls during a live model run, prompt-free status, cancellation, duplicate receipts, and the stopping fence with an invalid Slack token. This proves runtime behavior, not successful delivery to Slack or production rollout.
