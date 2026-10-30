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

- JavaScript (Node.js) runs in an offline Cloudflare Container, never the Worker
  host. There is no credential injection, outbound interceptor, exposed TCP port,
  deployment operation, or arbitrary HTTP fetch capability.
- Only requested code/file content is passed to the container, not the Worker
  environment, principal, provider keys, Slack token or GitHub installation token.
  The container starts the Cloudflare-managed `cloudflare/debian-trixie` image (Node.js on
  Debian Trixie slim), which contains no secrets. All processes within a session share trust;
  code can inspect or modify that session's entire Linux filesystem.
- Paths are relative to `/workspace`, max 256 ASCII characters. Empty components,
  traversal, absolute paths, percent encoding and backslashes are rejected.
  File IO is a fixed Node program that opens every component through
  `/proc/self/fd/<dirfd>` with `O_NOFOLLOW` (Node has no `openat`), not a
  check-then-follow symlink operation. Reads require a regular
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

## Integration

`server/cloudflare.config.ts` declares the container with the `durable-object` scheduling
policy and attaches it to the `SandboxContainer` export:

```ts
const sandbox = defineContainer({ name: "touka-sandbox", schedulingPolicy: "durable-object" });
// ...
SandboxContainer: exports.durableObject({ storage: "sqlite", container: sandbox }),
```

No Dockerfile or named image is declared: the Durable Object starts the managed image by name
(`SANDBOX_IMAGE` in `runtime.ts`). Deploy through the cf CLI only after configuring Container
access; local development needs Docker (`vp run dev`).

`Env` declares `SANDBOX_CONTAINER?: DurableObjectNamespace<SandboxContainer>`.
The tools use the equivalent structural internal RPC type. Keep this DO private: no public HTTP route
or trigger-controlled `getByName`. An absent binding/container fails explicitly;
it does not execute locally or fabricate a result. Tool registration remains
possible without the optional binding, so unrelated sessions still start.

## Working on a repository

`sandbox_checkout` puts a repository at a ref into `/workspace/<name>`. The Worker fetches the
archive from GitHub (read grant) and streams it in; the container stays offline and holds no
credential. The answer carries the commit sha, the file count, the repository's own `AGENTS.md` and
`CLAUDE.md`, and an index of its `.agents/skills`. `sandbox_shell` runs `bash -c` there (up to 10
minutes; output past about 48,000 characters is cut to its head and tail rather than failing).
`sandbox_publish` commits what differs from the checkout to an existing branch in one commit, through
the GitHub connector, and then makes that state the new baseline. It sends text files up to 64 KiB
with plain paths; others are listed as skipped and keep the baseline where it was.

Limits to know: no `git` and no network inside, so dependencies cannot be installed and tests that
need them cannot run; archives over 200 MB are refused; commits are signed by the App, not the user.

## Workspace snapshots

After every successful `execute` or `write`, the runtime takes a `snapshotContainer()` snapshot and
the DO stores its handle with the image it came from. When the container is destroyed (timeout, abort,
output overflow) or stops after inactivity, the next call restarts from the last snapshot instead of an
empty workspace. A snapshot is best-effort: if taking one fails, the previous one stays and the
operation still succeeds. A snapshot only restores onto the same image, and the platform expires
unused handles after 30 days, so an expired handle fails the start (no silent empty fallback).
Snapshots are a public beta feature of the `durable-object` policy.

Use `vp run dev` after integration, with Docker running; do not deploy generated
applications. The headless Worker runs independently of any browser or UI framework.

## Verification and limits

The tests are in-source (`vp test src/tools/sandbox`).
`vp check --no-fmt --no-lint` checks the native Container
types. Tests replace only Cloudflare's external execution
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
part of this check. Workspaces survive a container restart only through the
best-effort snapshots above; there are no backups or network package installation.

Sources inspected (2026-10-27):

- https://developers.cloudflare.com/sandbox/get-started/index.md
- https://developers.cloudflare.com/containers/guides/snapshots/
- https://developers.cloudflare.com/containers/guides/image-management/
- https://developers.cloudflare.com/sandbox/concepts/security/index.md
- https://github.com/cloudflare/sandbox-sdk/tree/main/examples/minimal
- Installed `@cloudflare/workers-types/index.d.ts` and Pi Durable tool execution types.
