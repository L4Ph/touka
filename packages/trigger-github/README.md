# GitHub mention trigger

Independent workspace package exporting `create` and `deliver`. The server is the
composition root: its package discovery mounts `/triggers/github` and registers
the reply handler with the shared SQLite outbox. It imports the public lifecycle contract and `@remote-agent/connector-github`;
no server internals, HTTP API client or token/JWT implementation live here.

## Configure the existing GitHub App

Subscribe to **Issue comments** and **Pull request review comments**, with the
webhook URL `https://<agent-server>/triggers/github`. Grant Issues and Pull requests
read/write permissions for replies and the tools. Allowlisted actors on configured
repositories get repository write for the tools (never merge, never `.github/workflows/`).
Configure server-only bindings:

- `GITHUB_WEBHOOK_SECRET`: the App webhook secret.
- `GITHUB_BOT_LOGIN`: the App's login. The `[bot]` suffix is optional: both `helper` and
  `helper[bot]` match a comment that mentions `@helper` or `@helper[bot]`, and the App's own
  comments (`helper[bot]`) are always ignored. Matching is case-insensitive.
- `GITHUB_ACTORS`: nonempty JSON array of allowed human logins, e.g. `["alice"]`.
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`: the existing App ID and PEM secret.
- `GITHUB_REPOSITORIES`: repository-to-installation map. Use `{"acme/*":456}` for a whole organization (it also covers repositories created later; the App installation's own repository selection still bounds it), or exact entries, which take precedence, e.g.
  `{"team/project":456}`. Matching repository AND installation is required.
- `TEAM_AUTH`: shared authenticated member policy for status access.
- The shared `PI_DURABLE` and `DELIVERY` bindings and operator model configuration
  must exist; failed durable acceptance returns 503, never a successful ACK.

Authenticated mention ingress is limited automatically before durable execution:
**20 requests per allowed actor and 100 total per 60-second fixed window**, shared
across all repositories, issue/PR numbers and delivery IDs in one trigger app.
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
server-validated read and write grant for that repository, never App tokens or source prompts.

Replies use `githubConnector(env).reply`, sharing App credentials and scoped token
cache with outbound Tools. The Connector bounds results below
GitHub's 65,536-byte comment limit with a visible truncation notice. Non-successful
agent results get recovery text rather than a false success claim.

Authenticated `GET /triggers/github/jobs/<owner>/<repo>/<number>/<delivery-id>`
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
vp test connector trigger
vp check --no-fmt --no-lint
```

Vite+ uses Vitest path filters. The tests live in `src/index.ts` (in-source) and drive the real
webhook handler with real HMAC signatures, faking only GitHub and the model at the HTTP boundary:
raw signature mutation, policy/shape/size/self/mention negatives, ACK refusals, the status emoji
lifecycle (👀 on acceptance, 🚀 or 😕 on delivery, no emoji for a redelivery) and a reply that must
not repeat when an emoji fails. No live GitHub App or deployment was used.

## What a conversation can see and do

One issue or pull request is one conversation (`repo#number`; issues and pull requests share the number space, so conversation and review comments share one). Only comments that mention the bot are added to it, as plain text; the repository and number never appear in the prompt.

The trigger gives the conversation `github:<repo>:read`, `github:<repo>:write` and a `github-thread:<repo>#<number>` marker. The agent tools read the marker to know which issue or pull request they are working on:

- Read: `github_get_issue` and `github_get_pull_request` (omit `repo` and `number` for the current thread), `github_read_file`, `github_list_files`, `github_search_code`, and, with the App holding Actions, Checks and Commit statuses read, `github_get_checks` and `github_get_job_log`.
- Write: `github_create_issue`, `github_update_issue`, `github_add_labels`, `github_comment`, `github_review_pull_request` (COMMENT, APPROVE or REQUEST_CHANGES with inline comments on diff lines, pinned to a commit), `github_reply_review_comment`, `github_request_reviewers`, `github_create_branch`, `github_write_file`, `github_commit_files` (several files and deletions in one commit), `github_open_pull_request`, `github_update_pull_request`. Nothing merges, and files under `.github/workflows/` need a `github:<repo>:workflow` grant that this trigger never gives.

## Status emoji

Accepting new work puts 👀 on the comment that started it (a redelivered webhook adds nothing). When the reply is out, 👀 becomes 🚀 if the agent answered and 😕 if it did not or GitHub refused the reply; a refusal retrying cannot fix (such as permissions that changed after the conversation began) puts 😕 on the comment and is answered with 200 so GitHub does not redeliver. The reply record keeps `commentId` and `commentKind` for this, and an emoji problem never fails or repeats the reply.

## Creating the GitHub App

`app-manifest.json` declares the App for the [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). It is private (`public: false`), subscribes to `issue_comment` and `pull_request_review_comment`, and asks for Metadata read plus Contents, Issues and Pull requests write. It also asks for Actions, Checks and Commit statuses read (CI results) and Workflows write; the Workflows credential is only minted for a conversation that holds `github:<repo>:workflow`, which ingress never grants. An App created earlier has to be given these permissions in its settings, and the installation owner has to accept them.

1. Pass the Worker's base URL as `?url=` when you open the page below; it replaces the placeholder `hook_attributes.url` with `<url>/triggers/github`. Without it the placeholder stays, and the URL can be edited later in the App settings.
2. Open a page that POSTs the manifest to `https://github.com/settings/apps/new` (or `https://github.com/organizations/<org>/settings/apps/new`). Save this as a local file and open it in the browser:

   ```html
   <form method="post" action="https://github.com/settings/apps/new">
     <input type="hidden" name="manifest" id="manifest" />
     <button>Create the App</button>
   </form>
   <script>
     const base = new URLSearchParams(location.search).get("url");
     fetch("app-manifest.json")
       .then((r) => r.json())
       .then((m) => {
         if (base) m.hook_attributes.url = `${base.replace(/\/$/, "")}/triggers/github`;
         document.getElementById("manifest").value = JSON.stringify(m);
       });
   </script>
   ```

   Serve it next to `app-manifest.json` (for example `python3 -m http.server 3000`) and open `http://localhost:3000/<file>.html?url=https://<worker>`, since `fetch` does not read `file://`.

3. After you confirm, GitHub redirects to `http://localhost:3000/?code=<code>`. The code expires in one hour. Exchange it once:

   ```sh
   gh api -X POST /app-manifests/<code>/conversions
   ```

   The response holds `id` (`GITHUB_APP_ID`), `pem` (`GITHUB_APP_PRIVATE_KEY`), `webhook_secret` (`GITHUB_WEBHOOK_SECRET`) and `slug`. Keep it out of logs and chat.

4. Install the App on the repositories, then read the installation ID with `gh api /user/installations` (or the App's installations page) and put it in `GITHUB_REPOSITORIES`, e.g. `{"owner/repo":456}` or `{"owner/*":456}` for the whole organization. Set `GITHUB_BOT_LOGIN` to `<slug>[bot]`.

Protocol references:

- https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
- https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request
- Shared lifecycle details: `../../server/src/README.md`.
