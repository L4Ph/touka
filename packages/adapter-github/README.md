# GitHub mention adapter

Independent workspace package exporting `create` and `deliver`. The server is the
composition root: its package discovery mounts `/adapters/github` and registers
the reply handler with the shared SQLite outbox. Only the public
`@remote-agent/adapter-contract` is imported; no server internals or token/JWT
implementation live here.

## Configure the existing GitHub App

Subscribe to **Issue comments** and **Pull request review comments**, with the
webhook URL `https://<agent-server>/adapters/github`. Grant Issues and Pull requests
read/write permissions for replies. Repository contents writes are not granted by
this adapter. Configure server-only bindings:

- `GITHUB_WEBHOOK_SECRET`: the App webhook secret.
- `GITHUB_BOT_LOGIN`: exact mention login, including `[bot]` when applicable
  (for example `helper[bot]`). Matching is case-insensitive.
- `GITHUB_ACTORS`: nonempty JSON array of allowed human logins, e.g. `["alice"]`.
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`: the existing App ID and PEM secret.
- `GITHUB_REPOSITORIES`: exact repository-to-installation map, e.g.
  `{"team/project":456}`. Matching repository AND installation is required.
- `TEAM_AUTH`: shared authenticated member policy for status access.
- The shared `SESSIONS` and `ADAPTER_JOBS` bindings and operator model configuration
  must exist; failed durable acceptance returns 503, never a successful ACK.

Authenticated mention ingress is limited automatically before durable execution:
**20 requests per allowed actor and 100 total per 60-second fixed window**, shared
across all repositories, issue/PR numbers and delivery IDs in one adapter app.
Actor logins are case-insensitive. The window starts with the first eligible
request. Excess requests return HTTP **429**, `Retry-After` in whole seconds and
`{error:"rate_limited",retryable:true}` without invoking durable execution. Retry
after that delay using the same delivery ID; GitHub redelivery may require an
operator or sender to initiate it. Invalid signatures, forbidden requests and
ignored events do not consume quota. Eligible retries and failed durable accepts
do consume quota; rejecting excess requests does not extend the window.

No extra binding or operator setting is needed. Counters are in-memory per
app/Worker isolate, not a durable or fleet-wide billing ceiling: eviction/restart
resets them, and multiple isolates each have their own budget. Use shared quota
storage or an additional managed edge policy if a deployment-wide ceiling is
required. The aggregate cap also bounds the actor counter map to 100 entries;
all counters clear at the next window. Raw request bodies are capped at
32 KiB, comment text at 16,000 characters, actors at 1,000. The shared outbox caps
retained jobs at 100 per session and Pi bounds pending work. Outbound 429, secondary
403 rate limits and 5xx use durable retries; Retry-After (seconds/date) or reset
headers are honored up to one hour. Network/auth transport failures are retried;
permanent authorization/permission failures are visible, not swallowed.

## Behavior and recovery

Raw-body SHA256 HMAC is verified before parsing. Only `created` issue/review
comments by allowed human authors are eligible. Bots, self, edits, other events,
nonmentions and empty mentions are ignored. Sender and comment author must match.
A standalone `@<configured login>` is removed without injecting origin labels.
Each exact repository + issue/PR number maps deterministically to one session;
review comments in that PR share its conversation. Review replies use the
original top-level review comment (`in_reply_to_id` when present).

`X-GitHub-Delivery` is the operation ID. After durable acceptance return 202 with
`{accepted, operationId}`; identical redelivery returns `accepted:false`, changed
content under that ID returns 409. The shared service owns model execution,
dedupe, alarms and result delivery; this package never runs a background model
loop inside the webhook. The session receives only session/operation/input and a
server-validated read grant for that repository, never App tokens or source prompts.

Replies use the shared App auth `token(repo, 'reply')`. Results are bounded below
GitHub's 65,536-byte comment limit with a visible truncation notice. Non-successful
agent results get recovery text rather than a false success claim.

Authenticated `GET /adapters/github/jobs/<owner>/<repo>/<number>/<delivery-id>`
returns durable state, attempt count, next due and safe failure codes. The caller's
`TEAM_AUTH` principal must have the corresponding session ID. It exposes no input,
result text or credentials. Inspect `failed`, repair credentials/policy, and use an
explicitly new operation if another attempt is intended; no automatic replay API
exists. The shared spine uses six send attempts, a 20-second deadline, 24-hour
active lifetime/dedupe retention and capped retry waits. Acceptance-time grants
are snapshots; revocation does not cancel already accepted jobs.

**At-least-once, not exactly-once:** if GitHub accepts a comment and the process
crashes before recording delivery success, restart/retry can post a duplicate.
GitHub comment creation has no idempotency key. Incoming delivery dedupe does not
eliminate that outgoing crash window.

## Local verification

From the repository root:

```sh
npm run test -- packages/adapter-github/
npm run typecheck
```

The root test script intentionally discovers **all** server/package tests and
ignores filter arguments. `src/github.test.ts` is discovered there; it builds the
actual composed Worker and drives real local HTTP, SQLite DOs and alarms through
Miniflare. Model and GitHub HTTP are boundary fakes. Tests cover raw signature
mutation, policy/shape/size/self/mention negatives, missing outbox, authorized
status, concurrent dedupe/conflict, ACK before a gated model, retry after runtime
restart, issue/review thread replies, UTF-8 truncation and durable failure.
The package pins the same Miniflare major as the server's runtime tests (the root
Void toolchain also installs an incompatible beta major). No live GitHub App,
production LLM, deployment or external credentials were used. Local restart tests
prove persisted retry scheduling, not exactly-once delivery at GitHub.

`src/ingress-rate.test.ts` builds the composed server and drives its real HTTP
routes and SQLite Durable Objects in Miniflare with real HMAC signatures. Only
the clock and external model/GitHub APIs are faked. It verifies durable records
for concurrent within-limit requests, cross-session/case-insensitive actor
rejection without jobs or sessions,
invalid signatures not spending quota, aggregate limits, Retry-After and exact
window recovery. It does not claim distributed/durable quota enforcement.
Run it directly from `server/` with:

```sh
node --import tsx --test ../packages/adapter-github/src/ingress-rate.test.ts
```

Protocol references:

- https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request
- Shared lifecycle details: `../../server/src/README.md`.
