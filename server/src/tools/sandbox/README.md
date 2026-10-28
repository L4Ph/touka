# Isolated task tools

`index.ts` implements the spine's `ToolModule.create(context)` seam. The existing
`./tools/*/index.ts` glob discovers it; there is no separate host shell registration.
Tools are `sandbox_execute`, `sandbox_read_file`, and `sandbox_write_file`.

## Authorization and behavior

The caller must be authorized for the session **and** have the corresponding
resource: `sandbox:<sessionId>:execute`, `sandbox:<sessionId>:read`, or
`sandbox:<sessionId>:write`. The model cannot choose a sandbox or target session.
The binding name is SHA-256 of the authorized session ID with a `sandbox-` prefix.
Session IDs must remain globally unique, as required by the core's session model.

- Python and JavaScript run in an offline Cloudflare Container, never the Worker
  host. There is no credential injection, outbound interceptor, exposed TCP port,
  deployment operation, or arbitrary HTTP fetch capability.
- Only requested code/file content is passed to the container, not the Worker
  environment, principal, provider keys, Slack token or GitHub installation token.
  Images must contain **no secrets**. All processes within a session share trust;
  code can inspect or modify that session's entire Linux filesystem.
- Paths are relative to `/workspace`, max 256 ASCII characters. Empty components,
  traversal, absolute paths, percent encoding and backslashes are rejected.
  File IO uses Python `openat`-style directory FDs and `O_NOFOLLOW` on every
  component, not a check-then-follow symlink operation. Reads require a regular
  UTF-8 file. Whole-file writes use same-directory atomic rename, so replacing a
  symlink never writes its target. Existing parent directories are required.
- Code and write content: 32 KiB UTF-8. Combined stdout/stderr and file reads:
  64 KiB UTF-8. Excess output aborts, rather than returning misleading success.
  Execution timeout is mandatory, 1–10,000 ms; file operations use 10,000 ms.
  A client watchdog allows an extra 1,000 ms for RPC transport and cancellation.
- Pi's execution `Context.abortSignal` sends an explicit cancellation RPC (RPC
  signals are not serialized). Native execution gets the local AbortSignal.
  Timeout/abort/output overflow destroys the session container to kill descendants;
  its workspace is lost. Concurrent calls fail `sandbox_busy`, not an unbounded
  queue. Nonzero execution returns `isError` with stdout/stderr/exitCode; file and
  transport failures throw stable `sandbox_*` errors without infrastructure text.
- Execution is `unsafe` for replay. Only reads and **whole-file replacement** are
  `safe`; there is no append, patch, command retry, branch creation or deployment.
  Replay does not provide transactional ordering against later independent writes.

## Integration (container provisioning is not enabled implicitly)

The shared spine already exports/binds the internal DO and adds its SQLite migration and Env contract. The export in `server/src/index.ts` is:

```ts
export { SandboxSession } from "./tools/sandbox/worker";
```

To provision an actual container, add the `containers` entry below to `server/wrangler.jsonc`.
The binding and migration already exist: do not add duplicates. Paths are relative to `server/`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": { "bindings": [{ "name": "SANDBOX", "class_name": "SandboxSession" }] },
  "containers": [
    {
      "class_name": "SandboxSession",
      "scheduling_policy": "durable_object",
      "images": { "sandbox": { "dockerfile": "./src/tools/sandbox/Dockerfile" } },
    },
  ],
  "migrations": [{ "tag": "sandbox-v1", "new_sqlite_classes": ["SandboxSession"] }],
}
```

`Env` already declares `SANDBOX?: DurableObjectNamespace<SandboxSession>`.
The tools use the equivalent structural internal RPC type. Keep this DO private: no public HTTP route
or trigger-controlled `getByName`. An absent binding/container fails explicitly;
it does not execute locally or fabricate a result. Tool registration remains
possible without the optional binding, so unrelated sessions still start.

The Dockerfile copies the **1.0.3** helper to match installed `@cloudflare/sandbox`;
update both together. The native Container API, not removed 0.x `getSandbox()` or
`runCode()` APIs, controls execution. `Files` initializes the workspace using its
installed API. Hardened file reads/writes use a fixed Python program because
`Files` follows native symlink semantics, unsuitable for untrusted generated paths.

This repository already uses Wrangler. Use the existing server dev command after
integration, with Docker running; do not deploy generated applications. The
headless Worker runs independently of any browser or UI framework.

## Verification and limits

`vp test src/tools/sandbox` selects the sandbox tests through Vitest path filters.
`vp check --no-fmt --no-lint` checks native Container
and installed Sandbox SDK APIs. Tests replace only Cloudflare's external execution
and RPC boundaries, using real Web Streams, byte limits and AbortSignals. They
exercise authorization, traversal, namespace isolation, execution/file dispatch,
replay policy, output overflow, nonzero exits, timeout/abort and transport failures.

No Cloudflare credentials or production integration evidence are available here.
Tests are **not** live Linux-container proof or a live LLM run. Container filesystem
and symlink-race behavior require Docker/Cloudflare integration validation after
wiring the above config. Before production: write/read a UTF-8 file, execute code
that prints it, create a symlink outside `/workspace` and verify read denial, run
an output flood and an infinite loop, stop one active call, and confirm another
session cannot read the first session's files. No generated app deployment is
part of this check. Workspaces are ephemeral; there are no snapshots, backups,
network package installation or durability guarantees across container restarts.

Sources inspected (2026-10-27):

- https://developers.cloudflare.com/sandbox/get-started/index.md
- https://developers.cloudflare.com/sandbox/commands/run-python-code/index.md
- https://developers.cloudflare.com/sandbox/concepts/security/index.md
- https://github.com/cloudflare/sandbox-sdk/tree/main/examples/minimal
- Installed `@cloudflare/sandbox/dist/index.d.mts` (1.0.3),
  `@cloudflare/workers-types/index.d.ts`, and Pi Durable tool execution types.
