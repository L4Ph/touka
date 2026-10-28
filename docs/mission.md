# Mandarin initial release

## Agreed scope

A general-purpose remote agent using Pi Durable, pi-ai, and the Cloudflare Agents SDK, with an independent core Worker and Void React Pages SSR/Vite+ UI. Cloudflare OS replacement and deployment operations are out of scope. Coding work stops at pull requests.

- **Core**: accepts session/operation/input without origin awareness. Each thread owns one Session DO/Pi conversation, with durable input, dedupe, restart recovery, stop, model controls, and snapshots/events.
- **Connector**: manages external authentication, reads/writes, and resource authority for GitHub, Slack, Discord, and MCP. Web-created conversations can use it independently.
- **Trigger**: starts work from GitHub/Slack mentions, Discord HTTP Interactions, or authenticated Webhooks. It owns signatures, actor/resource policy, conversation mapping, durable ACK, and reply outboxes, not implicit write authority.
- **Tool**: exposes Connector and other operations to Pi under server-validated grants, time/size limits, and side-effect-aware replay rules.
- **Web**: Better Auth protects team-shared session listing, history, input, stop, and model controls. Web/core are separate Workers; browsers use a same-origin authenticated proxy.
- **Models**: register built-in and arbitrary operator-defined pi-ai providers/models. Gateway is optional. Clients can select registered models, not register credentials or arbitrary endpoints.
- **MCP**: discover/call operator-configured Streamable HTTP tools using public access or configured headers and tool-level grants. Interactive OAuth, stdio, legacy SSE, resources, and prompts are out of scope.

## Acceptance criteria

1. Preserve official Void Pages SSR/Vite+ and build independent server and Web apps.
2. Keep service event types, mandatory source labels, and origin-specific system prompts out of Core.
3. ACK only after durable acceptance; never enqueue one operation ID twice.
4. Verify recovery and retained status, history, and models against real DO SQLite.
5. Reject anonymous/cross-origin HTTP and WebSockets; reconnect from a fresh snapshot.
6. Two Better Auth members can view the same conversation without expanding tool authority.
7. Separate Connector/Trigger/Tool packages and dependency direction without legacy Adapter runtime wrappers.
8. Limit the GitHub App to allowed repositories, forbid merge/deploy, and execute generated code only in isolation.
9. MCP connects only to configured URLs and granted tools, hides credentials from listings/errors, and enforces cancellation/output limits.
10. Distinguish empty, loading, running, tool, stopped, failed, disconnected, and retried UI states; support keyboard operation.
11. Run `vp run verify` and local Launch/Doctor/Drive/Cleanup; distinguish unverified live-service behavior.

## Implementation and verification

Implement and verify directly without worker orchestration. Run the Vite+ tasks in `package.json`; keep operational limits and configuration in the module documentation.

See `package.json` for commands, [connections](connections.md) for responsibilities, [shared web authentication](shared-web-auth.md) for auth, and the [README](../README.md) for setup and limits. Historical fixtures require Git history to read real earlier commits.

## Out of scope and external setup

Production deployment, Cloudflare OS/Gadgets, public SaaS, PR merge, credentialed live Slack/GitHub/Discord/MCP/LLM checks, and real Docker/Cloudflare Containers remain outside local verification. External writes/replies are not exactly-once. Pi conversation deletion and cursor event replay are unsupported.

The private repository is https://github.com/L4Ph/mandarin and its default branch is `main`. Open local tickets in `.r5/issues/` track live-service setup and future deployment support.
