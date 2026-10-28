# Mandarin initial release

## Agreed scope

A general-purpose headless remote agent using Pi Durable, pi-ai, and the Cloudflare Agents SDK in one Worker, with Vite+ tooling. Cloudflare OS replacement and deployment operations are out of scope. Coding work stops at pull requests.

- **Core**: accepts session/operation/input without origin awareness. Each thread owns one Session DO/Pi conversation, with durable input, dedupe, restart recovery, stop, model controls, and snapshots/events.
- **Connector**: manages external authentication, reads/writes, and resource authority for GitHub, Slack, Discord, and MCP, independently of the initiating Trigger.
- **Trigger**: starts work from GitHub/Slack mentions, Discord HTTP Interactions, or authenticated Webhooks. It owns signatures, actor/resource policy, conversation mapping, durable ACK, and reply outboxes, not implicit write authority.
- **Tool**: exposes Connector and other operations to Pi under server-validated grants, time/size limits, and side-effect-aware replay rules.
- **Management API**: Hono routes provide bearer-authenticated session listing/creation, history, stop/retry, model controls, operation status, and WebSocket events. Session listing uses the caller's explicit allowlist, not a global index.
- **Models**: register built-in and arbitrary operator-defined pi-ai providers/models. Gateway is optional. Clients can select registered models, not register credentials or arbitrary endpoints.
- **MCP**: discover/call operator-configured Streamable HTTP tools using public access or configured headers and tool-level grants. Interactive OAuth, stdio, legacy SSE, resources, and prompts are out of scope.

## Acceptance criteria

1. Build the headless Worker and run tests/checks using native Vite+ tasks, without a Web framework, UI, or auth database.
2. Keep service event types, mandatory source labels, and origin-specific system prompts out of Core.
3. ACK only after durable acceptance; never enqueue one operation ID twice.
4. Verify recovery and retained status, history, and models against real DO SQLite.
5. Reject unauthenticated or session-forbidden HTTP and WebSocket access, including direct DO access; reconnect from a fresh snapshot.
6. Keep session visibility separate from Tool authority, retaining the persisted execution grant across restart and later input.
7. Separate Connector/Trigger/Tool packages and dependency direction without legacy Adapter runtime wrappers.
8. Limit the GitHub App to allowed repositories, forbid merge/deploy, and execute generated code only in isolation.
9. MCP connects only to configured URLs and granted tools, hides credentials from listings/errors, and enforces cancellation/output limits.
10. Preserve earlier migration tags and conversation namespaces when retiring the former Web directory.
11. Run `vp run verify` and local Launch/Doctor/Drive/Cleanup; distinguish unverified live-service behavior.

## Implementation and verification

Implement and verify directly without worker orchestration. Run the Vite+ tasks in `package.json`; keep operational limits and configuration in the module documentation.

See [connections](connections.md) for responsibilities and the [README](../README.md) for authentication, management routes, migration, setup, and limits. Historical fixtures require Git history to read real earlier commits.

## Out of scope and external setup

Web UI, production deployment, Cloudflare OS/Gadgets, public SaaS, PR merge, credentialed live Slack/GitHub/Discord/MCP/LLM checks, and real Docker/Cloudflare Containers remain outside local verification. External writes/replies are not exactly-once. Pi conversation deletion and cursor event replay are unsupported.

The private repository is https://github.com/L4Ph/mandarin and its default branch is `main`. Open local tickets in `.r5/issues/` track live-service setup and future deployment support.
