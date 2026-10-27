# Discord HTTP Interactions adapter

Independent npm workspace using `discord-hono` 0.22.2 (real raw-body Ed25519 verification, PING and command dispatch). Server composition discovers its `create`/`deliver` exports automatically. No Discord types or source labels enter Pi. Root Void SSR and core Worker remain independently deployable.

## Server configuration

Set server-only bindings/secrets (never `VITE_*`):

```dotenv
DISCORD_APPLICATION_ID=111111111111111111
DISCORD_PUBLIC_KEY=<64 hex characters from Developer Portal>
DISCORD_ADMIN_TOKEN=<independent operator secret>
DISCORD_GUILDS=[{"id":"222222222222222222","actors":["444444444444444444"],"resources":[]}]
```

Both exact guild AND actor membership are required; bots and DMs are rejected. DMs have no supported opt-in in this release. Missing/invalid policy fails closed. Resource grants are operator-owned, e.g. `github:team/project:read`; session visibility does not grant tools. Existing conversations retain their acceptance-time grant, so changing resources requires a new conversation.

Set the application's **Interactions Endpoint URL** to `https://<core-worker>/adapters/discord`. PING validates the application ID and signature. Install with `applications.commands` and authorize the command for the intended team members. This is **`/ask prompt:<task>` only**, not raw mentions, Gateway `MESSAGE_CREATE`, or a Gateway connection. Command authorization in Discord is an additional gate, never a substitute for server allowlists.

`channel_id` is the conversation key: an actual Discord thread has its own channel ID and therefore its own Session DO. Repeated `/ask` calls in a regular channel share that channel's conversation. Parent and child threads are not merged. Session IDs are `discord_<guild>_<channel>` and are registered in the shared durable team directory, not copied per viewer.

## Offline command registration

```sh
DISCORD_APPLICATION_ID=111111111111111111 DISCORD_REGISTER_GUILD=222222222222222222 \
  npm run register --workspace @remote-agent/adapter-discord
```

This **only prints** a POST URL and JSON body, performs no network call, and requires no bot token. After inspecting the output, an operator may manually POST that body to the printed URL using `Authorization: Bot <server-only bot token>` (for example with curl). POST creates/upserts the named command without replacing unrelated commands. The default permissions are disabled (`"0"`); explicitly grant the command to intended members/roles in Discord server Integrations. This task does not register commands or deploy anything.

## Durability, deadlines and visibility

The shared `execute` seam transactionally accepts input plus outbox before `resDefer()` (type 5). No model call or `waitUntil` job runs before ACK. Initial work is bounded to a 2.5-second acceptance budget (Discord requires an initial response within 3 seconds). A timeout returns 503, never fictitious success; a timed-out durable RPC may still commit, so retries must preserve interaction ID. Unknown interactions already older than 2.5 seconds are rejected; known durable duplicates may ACK again. Payloads are capped at 32 KiB and timestamps at ±300 seconds. Authenticated ingress is limited per isolate to 20 interactions per guild/actor and 100 total per minute (duplicates count too, 429 includes Retry-After). Configure edge ingress rate limiting as well; shared queues also cap retained jobs at 100 per conversation. There is no cross-isolate account-wide quota.

Interaction ID dedupes submissions. Tokens/expiry remain only in private durable outbox metadata, never prompts, status, or logs. Disable request URL/body logging at the external API boundary too. Completion PATCHes the deferred original response, disables all mentions and truncates to 2,000 characters. Repeating an edit after a crash is safe for the original message. It never silently posts a bot fallback.

Tokens expire 15 minutes after the interaction snowflake creation time. Expired/unknown tokens fail terminally as `interaction_token_expired`; 429 respects Retry-After unless it would exceed expiry, and 5xx/network errors use shared bounded retries. Shared delivery bounds remain six attempts, 20-second send timeout and 24-hour job lifetime. There is no automatic token renewal or dead-letter replay. Results remain available in the team session even if Discord delivery fails.

Operator status: `GET /adapters/discord/jobs/<guild>/<channel>/<interaction>` with `Authorization: Bearer <DISCORD_ADMIN_TOKEN>`. It returns sanitized state/attempts/failure, not tokens or prompts. For expired tokens inspect the original shared session and create a new authorized interaction if needed.

## Evidence and primary references

`npm run verify:discord` uses generated Ed25519 keys with the real framework's in-process request path for PING, invalid/stale signatures, oversized/malformed bodies, and actor/guild/application/DM rejection. Local workerd/SQLite exercises actual durable acceptance (job state observable at ACK while the external model is gated), duplicate acceptance, a fresh interaction returning 503 within three seconds while a gated Discord send blocks the real outbox's acceptance (the gate opens only after the non-success response), missing outbox rejection, shared directory registration, parent/thread/sibling isolation and repeated-thread history, 429 and restart delivery, and terminal unknown/expired-token failure. LLM and Discord HTTP are boundary fakes; no live Discord/LLM/deployment evidence is claimed.

- https://discord-hono.luis.fun/ja/
- https://discord-hono.luis.fun/interactions/discord-hono/
- https://docs.discord.com/developers/interactions/receiving-and-responding
- Installed `discord-hono/dist/index.mjs` and `index.d.mts`: default `verify`, `fetch`, `resDefer` (without lazy callback).
