# Connector / Trigger / Tool

```text
Void Pages SSR → authenticated WebGateway ───────────┐
External Event → Trigger → durable inbox/outbox ─────┤
                                                   ↓
                                      Agent Core (Pi Session DO)
                                                   ↓
                                           Tool + server grant
                                                   ↓
Trigger result routing → Connector ←────────────────┘
                           ↓
                     External service API

agent-contract ← Core, Tools, trigger-contract
trigger-contract ← Trigger packages, server composition/outbox
Connector packages ← Trigger packages, Tools (never the reverse)
```

- `packages/agent-contract`: transport-neutral session/operation/input, principal and control-plane types. No service payload/source enum/auth helper.
- `packages/trigger-contract`: typed durable execution/status/result delivery lifecycle. No Connector-specific capabilities injected into the generic outbox.
- `packages/connector-github`: App RSA JWT, scoped installation token caching/refresh/invalidation, repository authorization, validated file/branch/PR operations and comment API/error/rate-limit handling. `githubConnector(env)` is shared by Trigger reply delivery and outbound Tools. Each read/write operation takes explicit server resource grants; write does not imply read. Reply capability can post only comments, never contents. No arbitrary API URL/merge/deploy operation is public.
- `packages/connector-slack`: configured workspace credentials and Web API operations via the installed `slack-web-api-client`. SDK in-memory retry is disabled; the durable outbox handles 429 scheduling. Tokens are not returned by `slackPolicies`. The SDK has no abort-signal option: the outbox still enforces its 20-second deadline, but an in-flight SDK request cannot be cancelled and may complete after timeout (at-least-once delivery).
- `packages/connector-mcp`: operator-configured Streamable HTTP MCP endpoints, header-secret resolution, session/tool grants, bounded SDK connections and sanitized failures. Pi lists/calls permitted remote tools through `server/src/tools/mcp/`; no inbound Trigger is needed. Setup and limitations: [MCP Connector](../packages/connector-mcp/README.md).
- `packages/connector-discord`: application-bound interaction response REST, token expiry and 429/expiry/error handling. No implicit bot fallback. Interaction credentials cannot be reused for unrelated channels or after expiry.
- `packages/trigger-{github,slack,discord,webhook}`: inbound signatures, allowlists/filtering, event-to-conversation mapping, durable accept before ACK, dedupe and result routing. Slack protocol stays in `slack-cloudflare-workers`, Discord Interactions in `discord-hono`. Event means data; only Trigger is an executable ingress module.
- `server/src/tools/github`: Pi tool schemas/replay declarations, session authorization, and Connector composition using the persisted server resource grant. Web-created conversations use `WEB_RESOURCES`, never browser-supplied grants. Existing conversations keep their original grants; viewing/continuing through Web cannot widen them. Slack/Discord resource grants require explicit operator policy; GitHub ingress grants read on the authorized repository, never contents-write. Service credentials are not agent authority.

Packages are discovered from `trigger-*/src/index.ts`; routes are `/triggers/<name>`. Old packages/routes are removed, not forwarded. This is a source/package cutover, not a production-data migration. Historical M0 fixtures stay pinned to their original commit and original routes.

## Verification

```sh
vp test connector trigger
vp test connector-mcp test/mcp.test.ts
vp run verify
vp test auth-test
vp test trigger-discord test/discord.test.ts
vp test web-test
vp check
```

`vp test connector trigger` exercises real Connectors with only external HTTP faked: RSA/scoped cached tokens, denied repository/resource grants, optimistic writes, UTF-8 reply bounds, rate limits and sanitized errors. The Tool test uses the same environment for a Trigger reply and a web-session Tool read and rejects contents writes/session denial without additional vendor requests. Owning API tests moved to Connector packages rather than being copied. Composed GitHub/Slack tests and the shared delivery test use real workerd/SQLite/HTTP/alarms, signatures, gated model ACK ordering, duplicate/conflicting events, retry deadlines and restart/outbox recovery. `vp test auth-test` additionally proves real shared-web continuation cannot widen a Trigger conversation's resource grant. Model/vendor/OAuth boundaries are fakes, not live-service evidence. No production credentials, deployment or remote writes were used.
