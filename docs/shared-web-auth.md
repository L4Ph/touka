# Shared web authentication

The root Void React Pages SSR application remains independently deployable from `server/`. Its UI is still the starter; the web-client unit owns rendering. Browser authentication is **Better Auth**, not `TEAM_AUTH`.

## Operator configuration

- Root `void.config.ts` selects providers (`github` by default). Configure `AUTH_GITHUB_CLIENT_ID`, `AUTH_GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET` and comma-separated exact verified addresses in `TEAM_EMAILS` on the **web Worker**. Missing/empty membership fails closed. Use a separate OAuth application from the bot GitHub App. Other Void social providers can be selected by operators; they must supply verified email identities. Password signup and account linking are disabled. Allowlisted verified OAuth users are provisioned just in time.
- Keep `AGENT_CORE` as a service binding to the core Worker's **named `WebGateway` entrypoint**. Do not route a public URL to that entrypoint or share the binding with untrusted Workers. Only this binding conveys verified identity. Headers from browsers are discarded, and the public core Worker still requires machine bearer authentication. Root `/api/auth/*` belongs to Void/Better Auth, outside the agent guard.
- Root auth uses one D1 database (`DB`). `npx void db generate` generated the checked-in `db/migrations` SQL and metadata. Review/apply it through Void's direct Cloudflare migration workflow before any future deployment; configure the real D1 database for that deployment. Do not create another auth database in core. No deployment was performed here.
- Core `SESSION_DIRECTORY` is the SQLite `SessionDirectory` DO binding/migration in `server/wrangler.jsonc`. All newly accepted adapter inputs and Web creates register the original session ID. Registration precedes conversation acceptance; retries are idempotent. An interrupted create can leave an index candidate, but readers filter candidates without a conversation. No per-viewer copies exist.
- Existing machine-allowlisted session IDs are backfilled on listing. **Pre-index adapter IDs not present in `TEAM_AUTH.sessions` must be supplied in server-only `SESSION_INDEX_SEEDS` (JSON string array)** before rollout, using the adapters' existing deterministic mapping/operational records. DO namespaces cannot be enumerated. Keep the combined migration seed set at most 1,000 IDs; split a larger historical migration operationally before enabling the web app. Once registered, IDs survive restart. Do not claim unknown historical IDs were discovered automatically.
- Optional core `WEB_RESOURCES` is a JSON string array (default `[]`) for newly bound Web threads. Use the tools' exact resource format, e.g. `github:owner/repo:read`. This is operator-only. Shared continuation reuses an adapter thread's persisted grant, never the viewer's identity or a wildcard grant. Changing configuration does not retroactively widen an existing thread's grant. Legacy queued unbound work cannot acquire new tools.

## Browser contract

```ts
import { auth } from "void/client";
import { teamClient } from "./shared/web-client";

await auth.signIn.social({ provider: "github", callbackURL: "/" });
const client = teamClient(window.location.origin);
const response = await client.api.sessions.$get();
await auth.signOut();
```

`teamClient` carries Hono's `ControlApi` type through the same-origin cookie proxy, with no bearer token or browser storage. For typed server identity/SSR use `getSession`/`requireAuth` from `void/auth`. Root `auth.ts` owns membership-at-registration and the proxy rechecks membership and verified email on every request.

All core control routes are available under **`/api/agent`** instead of `/api`: models; session create/detail/messages/runtime/operation; model change; abort/retry. Additional contracts:

- `GET /api/agent/sessions?after=<id>&limit=50` returns `{sessions, next}`. Limits are 1–100; cursors are session IDs, ordered lexically. Follow `next` even if a page is empty (an interrupted registration can be filtered). This is an ID directory, not a search or activity-sort API.
- `POST /api/agent/sessions/:id/inputs`: exactly `{operationId, input}`; stable operation IDs on retry; 202 receipt, 429 queue full. Caller-supplied resources/principals are rejected. Body limit 32 KiB; input 16,000 UTF-8 bytes.
- `GET /api/agent/sessions/:id/events`: native same-origin WebSocket with normal auth cookies, **not** `hc`'s HTTP fetch. Uses `shared/stream.ts`: fresh snapshot, then events, client `{type:'ack', sequence}` and `{type:'unsubscribe'}`. Reconnect to obtain a new snapshot. No cursor replay. No auth query strings.

Every authenticated member can read and continue every thread, and can stop/retry it or select a registered model. Stops affect the **shared** execution, not just that viewer; model changes affect subsequent provider calls, not an already-running request. Users cannot set provider credentials/endpoints or tool grants. Tools retain independent server-side resource checks, including when a fake or real model requests an unauthorized tool.

## Security and revocation

Better Auth keeps its CSRF/OAuth state protections. Secure, HttpOnly, SameSite cookies are forced; use localhost for development or HTTPS. Session cookie caching is disabled so database revocation is effective on the next HTTP request/WS handshake. Authenticated proxy responses use `no-store`. Mutations and WS require an exact same-origin `Origin`; cross-origin reads are also refused. No CORS credential whitelist, bearer plugin, localStorage session, or trusted browser principal header is provided.

The root proxy owns the browser WebSocket. Before forwarding each server frame it checks the real auth D1 session and current verified team identity; logout/deletion/expiry prevents subsequent data delivery. A five-second DB check also closes idle sockets (1008). In-flight frames already delivered before logout cannot be recalled. Reconnect always reauthenticates. Core bounds frames/consumers; the proxy additionally bounds pending outbound bytes. WS commands cannot submit input or change grants.

## Local evidence

`npm run verify:auth` builds both independent Workers, applies the generated SQL to real local D1 and exercises actual Better Auth OAuth callbacks/cookies, HTTP, Session DO SQLite, directory persistence and WS with Miniflare/workerd. Only upstream GitHub OAuth/App APIs, Slack replies and the LLM SSE service are fakes. With configured read-only `WEB_RESOURCES`, the fake model requests a real GitHub read and then a forbidden write; both users must see the authorized file content and `github_forbidden` in the same persisted transcript. Tests cover two users seeing one persisted conversation, pre-index machine backfill, signed Slack thread discovery outside machine allowlists/seeds by both users before and after runtime reopen, idempotent Web creation/submission, pagination, shared adapter continuation without replacing its grant, anonymous HTTP/WS, forged public headers, unverified/non-team accounts, disabled signup, cross-origin requests, secure cookies, logout/active-socket closure, verified-email and membership revocation while retaining real DB sessions (HTTP/WS denial and active-socket closure), missing/empty membership configuration, DB session revocation and reopen.

The pinned server test runtime supports compatibility date 2026-08-01; the root build keeps its existing 2026-10-01 deployment date. This is local runtime evidence, not a deployment, live OAuth/LLM/GitHub connection or completed web UI. Provider-specific live OAuth callbacks and production secrets remain operator work.
