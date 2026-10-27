# Outbound GitHub App capability

This directory is discovered by the spine's `ToolModule.create(ToolContext)` seam. It has no inbound webhook routes or origin-dependent prompts. `createGitHubAppAuth` is the server-only auth seam for the separate GitHub adapter; reuse its returned object to reuse its token cache. Do not register `token()` as a model tool or serialize its result.

## Configuration and authorization

Worker secrets: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (RSA PEM, PKCS#1 or PKCS#8), `GITHUB_REPOSITORIES` (JSON object, e.g. `{"team/project":42}`, mapping exact repository names to installation IDs). Missing or invalid configuration fails closed. These optional bindings are described by the exported `GitHubEnv` type; they never enter tool arguments.

The host must supply an authenticated principal whose `sessions` contains the tool context's session ID. Resource grants are exact strings: `github:team/project:read` and independently `github:team/project:write`. Write does not imply read; grant both for the full workflow. Neither the model nor tool arguments can widen these grants. The shared spine now persists the authenticated principal and logical session/resource grant before submission and restores it for tools after eviction; unbound legacy work still cannot use these tools. A conversation's grant cannot silently change (403); see `../../README.md`. An App installation must also actually have access to that repo and the requested permissions.

App JWTs use RS256 with iat 60 seconds in the past and expiry 9 minutes ahead. Installation tokens request only one configured repository and the required contents/PR permissions. Credentials are cached separately by repo and permission set, refreshed with a 60-second expiry margin, and evicted after API 401. Adapters reuse this same exported auth implementation with `token(repo, 'reply')` for issues/PR write without contents write; tools use independent read/write scopes. Tokens, private keys, JWTs, and remote error bodies are never returned by tools. Only fixed GitHub API endpoints are reachable; redirects are refused. Requests have a 15-second deadline and streamed JSON responses are capped at 600 KB. UTF-8 file reads are capped at 400 KB encoded content; writes at 100,000 characters; PR bodies at 20,000 characters. Large/binary files and directory listings are intentionally unsupported.

## Side effects and retries

- File reads are replay-safe, but an unpinned branch ref may read newer contents on retry; use a commit SHA for a stable read.
- Branch creation is **unsafe**, never automatically replayed. An existing branch fails (GitHub 422), without force-updating it. After an ambiguous transport failure inspect GitHub before retrying; an existing branch is not assumed to be yours.
- File writes are **unsafe**, never automatically replayed. `expectedSha` is required: the observed blob SHA for an update, or explicit `null` for create-only. GitHub rejects stale updates and attempts to overwrite an existing file without its SHA. After success an identical retry normally conflicts; inspect the current file before any new operation. The contents API provides blob-level optimistic concurrency, not an expected branch-tip transaction.
- PR creation is **unsafe**, never automatically replayed. GitHub normally rejects an already-open head/base pair with 422. This is not a durable idempotency key: inspect GitHub after an ambiguous failure and before retrying, especially if someone closed the first PR. Exactly-once external effects are not claimed.
- 401 invalidates that credential for the next explicitly initiated call; it does not replay the failed request. 403, 409, 422, 429 and network errors are surfaced without retry. `GitHubError.status` and bounded numeric `retryAfter` are available to server callers; remote response messages are discarded. Callers should honor rate limits rather than immediately retry.

No merge, deployment, arbitrary API, repository settings, deletion, shell, or ambient fetch tools exist. Repository writes can trigger repository-configured CI/automation; this module cannot suppress that external behavior. Apply repository protection policies appropriately.

## Evidence

`github.test.ts` runs the real tool implementations against a localhost HTTP GitHub boundary, verifies real RSA signatures with a generated key, authorization, optimistic conflicts, duplicate branch/PR behavior, new-file creation, status handling, and clock-advanced token refresh. The external API's host is routed to localhost only in tests; no external credential or live GitHub evidence is claimed. No DO/model is needed for this outbound capability. The server runner discovers `src/**/*.test.ts`; root `npm run test -- server/src/tools/github` currently ignores the filter and executes the full suite.

Primary protocol references: [App JWTs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app), [installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app), [contents API](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents).
