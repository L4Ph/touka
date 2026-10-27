# Server extension contracts (M2)

The root Void SSR app and `server/` remain independent Workers. Core input is only
`sessionId / operationId / input`. Never put origin metadata, external payloads or
origin prompts in it. Authentication, actor/resource allowlists, deterministic
thread mapping and reply formatting belong in `packages/trigger-<name>/`.

## Workspace triggers

`plugins.ts` discovers `packages/trigger-*/src/index.ts` at build time (excluding the contract package). Each independent npm package exports its entry point and depends on `@remote-agent/trigger-contract`; no trigger imports server internals or core implementation. Export:

- `create(dependencies: TriggerDependencies): Hono<TriggerAppEnv>`: mounted at
  `/triggers/<directory>`. Authenticate every inbound/status route yourself.
- `deliver(context: DeliveryContext): Promise<DeliveryResult>`: optional durable
  reply handler, registered under that same directory name without central edits.

Public lifecycle contracts: `packages/trigger-contract/src/index.ts`; transport-independent core envelopes: `packages/agent-contract/src/index.ts`. Server `trigger.ts` injects authentication, submit, execute and status; only this composition root accesses durable namespaces. Service API/auth implementations live in `packages/connector-*`, imported directly by Triggers and Tools, never injected into Core. `dependencies.execute(env, execution)`
accepts `{trigger, input, principal, reply}`. `principal` must come from validated
server-side actor/resource policy, **never request JSON or model arguments**.
Use a stable principal ID for a conversation and exact resource grants such as
`github:owner/repo:read`, `github:owner/repo:write`,
`sandbox:<sessionId>:read|write|execute`. Session access alone grants no tools.
`reply` is trigger-owned JSON (max 8192 UTF-8 bytes), including external thread IDs
and audit metadata. It is persisted separately and is never passed to Pi.

Example shape for `packages/trigger-example/src/index.ts` (protocol functions are implemented
by that trigger, not the spine):

```ts
import { Hono } from "hono";
import type {
  TriggerAppEnv,
  TriggerDependencies,
  DeliveryHandler,
} from "@remote-agent/trigger-contract";
import { authenticateAndMap, sendReply } from "./protocol";

export function create({ execute }: TriggerDependencies) {
  return new Hono<TriggerAppEnv>().post("/", async (c) => {
    // Must verify signature, freshness, allowlists, bounded payload and ignore bots.
    const { input, principal, reply } = await authenticateAndMap(c.req.raw, c.env);
    const receipt = await execute(c.env, { trigger: "example", input, principal, reply });
    return c.json(receipt, 202); // ACK only after durable job acceptance.
  });
}
export const deliver: DeliveryHandler = async ({ env, job, result, signal }) => {
  // Format the result here; the service Connector owns HTTP, credentials and API errors.
  return sendReply({ env, reply: job.reply, result, signal });
};
```

Return `{status:'delivered'}`, `{status:'retry', code, retryAfterMs?}` or
`{status:'failed', code}`. Codes are bounded snake_case, never remote bodies,
credentials, prompts or exception text. Convert vendor 429 Retry-After (seconds
or HTTP-date) to milliseconds. Treat 429/5xx/temporary network errors as retry;
invalid credentials/permissions/destination are permanent unless explicitly
recoverable. Truncate/chunk model results to vendor limits inside your handler.
`done`, `unanswered`, `parked` results are delivered, including safe failure or
recovery text chosen by the trigger; do not claim a parked operation succeeded.

## Durable execution and outbox

`TriggerJobs` is an exported SQLite DO, bound as `TRIGGER_JOBS`. The shared
capability selects one object per trigger/session. Its RPC `accept()` validates
and persists the whole job **and alarm transactionally** before returning
`{accepted, operationId}`. Model work starts in the alarm, not the webhook request.
Duplicate operation IDs with identical input/grant/reply return `accepted:false`;
conflicting content returns `delivery_conflict`. The session separately dedupes
Pi submissions, including a crash between submit and the outbox update.

States: queued → waiting → delivering → delivered/failed. `status(operationId)`
returns state, attempts, next due and structured `{code, attempts}` failure, not
prompt/reply data. RPC is internal; triggers must authenticate and authorize any
HTTP status surface. There is no unauthenticated shared job endpoint.

Limits: 100 retained jobs per trigger/session, max 24h active lifetime, one job
per alarm, 1-second pending polls, 6 external delivery attempts, 20-second handler
deadline with an abort signal. Honor the signal: an ignored abort cannot cancel a
remote side effect. Retry delays are 1/2/4/8/16 seconds (cap 60s), or the larger
vendor delay capped at 1h. Full queues fail with `delivery_queue_full`; completed
jobs retain dedupe receipts until lazily purged on acceptance after 24h. There is
no global account quota; operators must rate-limit authenticated ingress too.

Before every RPC/send, persist a wake; before a send, persist the consumed attempt.
A crash can leave a 21-second lease. A crash after the vendor accepts a reply but
before local success commits **can duplicate the reply**. Use vendor idempotency
keys when supported; never advertise exactly-once. After attempt 6 or 24h a job
fails visibly. No automatic dead-letter replay API exists: inspect status, fix
the credential/destination and use an explicitly new authorized operation when
appropriate. Persisted jobs/grants are acceptance-time authorization snapshots;
configuration revocation does not retroactively cancel accepted work.

The core persists a canonical logical-session/principal/resource grant before
accepting authenticated input and reuses it after eviction. A different principal
or resource set for that conversation is `execution_grant_conflict` (403); use a
new session when intentionally changing authority. Legacy queued operations cannot
receive tools retroactively. This is intentionally conservative instead of
switching authority underneath concurrently queued Pi work.

Server composes package exports, registration and durable binding. Packages never import `delivery.ts` or access `SESSIONS` directly. New trigger packages need no central export, binding or registry edits; `src/index.ts` supplies the handlers. Root Void UI and server remain independently buildable/deployable. GitHub, Slack and Discord Triggers use their independent Connector packages. See [dependency direction](../../docs/connections.md).

## Configuration (server-only, no embedded secrets)

`Env` in `env.ts` is the shared binding contract. `wrangler.jsonc` exports/binds
`SessionAgent`, `TriggerJobs`, `SandboxSession`, with an additive v2 SQLite
migration; v1 is retained. Sandbox container provisioning remains explicit using
`tools/sandbox/README.md`; absent containers fail closed, never run on the host.

| Name                                                                   | Contract                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `TEAM_AUTH`                                                            | Secret JSON members `{token,id,sessions,resources}`; fail closed                                   |
| `MODEL_PROVIDER`, `MODEL_ID`                                           | Explicit pi-ai model selection                                                                     |
| `MODEL_PROVIDERS`                                                      | Server-only `ProviderConfig[]` JSON; endpoints/models/auth secret names; see root README           |
| SDK provider secret env names                                          | Arbitrary string Worker bindings resolved through pi-ai authContext; no fixed allowlist            |
| `operator-providers.ts`                                                | Operator-owned typed SDK `Provider[]` registration for custom APIs/auth/metadata                   |
| `CLOUDFLARE_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID` | Optional AI Gateway configuration                                                                  |
| `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`                         | HTTP Interactions application ID and Ed25519 public key                                            |
| `DISCORD_GUILDS`, `DISCORD_ADMIN_TOKEN`                                | Exact guild/actor/resource JSON policy and status secret; see `packages/trigger-discord/README.md` |
| `SLACK_SIGNING_SECRET`                                                 | Slack signing secret                                                                               |
| `SLACK_WORKSPACES`                                                     | Secret JSON workspace/actor/token/resource policy; see `packages/trigger-slack/README.md`          |
| `SLACK_ADMIN_TOKEN`                                                    | Slack delivery status operator secret                                                              |
| `GITHUB_WEBHOOK_SECRET`                                                | GitHub App webhook secret                                                                          |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`                              | App ID and server-only PEM secret                                                                  |
| `GITHUB_REPOSITORIES`                                                  | Exact JSON `owner/repo` → positive installation ID map shared by tools and trigger                 |
| `GITHUB_ACTORS`, `GITHUB_BOT_LOGIN`                                    | Trigger-owned actor allowlist and self-reply filter configuration                                  |
| `SESSIONS`, `TRIGGER_JOBS`, `SANDBOX`                                  | Private DO namespaces, never expose RPC publicly                                                   |

Shared GitHub installation authentication is **one implementation** in
`packages/connector-github`. `githubConnector(env)` serves Trigger replies and
outbound Tools using the same environment-scoped cache. Its internal auth requests
short-lived repository-scoped read/write/reply permissions in separate caches. Reply scope requests issues/PR write, not contents write. No caller chooses
arbitrary installation IDs or token URLs. GitHub Workers fetch uses `manual`
redirect mode and rejects non-2xx, including redirects; Workers does not implement
`redirect:'error'`. Do not create another App JWT/token implementation in a Trigger or Tool.

## Evidence

`npm run verify:delivery` builds a new workspace-owned authenticated trigger into
the unchanged real Worker, then drives actual local HTTP, PiHarness, SQLite DO
alarms, in-flight send interruption/reopen, the real 20-second non-resolving handler
deadline, 429/backoff, permanent failure, retry exhaustion, queue bounds and dedupe.
A queued tool-using operation resumes after reopen without a new authorized submit;
the real registered GitHub tool receives its persisted resource grant and logical
session. A session-only principal is denied. Slack's real library rejects a successful
ACK when the durable outbox binding is absent. Only the LLM, GitHub
HTTP and reply vendor boundaries are deterministic fakes. No live LLM/vendor,
production secrets, deployment, or exactly-once claim.
