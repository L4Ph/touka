# Sandbox

Each session has its own Linux container (`SandboxContainer`, the managed `cloudflare/debian-trixie`
image). Pi Durable's own `read`, `write`, `edit` and `bash` tools run in it: `PiDurable` gives the
harness an `ExecutionEnv` (`env.ts`) and the tools are installed unmodified with `createCodingTools()`.
Files live under `/workspace`.

## How the tools reach the container

`container.ts` starts the container, fetches the pinned [pi-env](https://github.com/earendil-works/pi)
daemon into it (checked against a SHA-256) and runs it with stdin and stdout piped back over Workers RPC.
`connection.ts` speaks pi-env's wire protocol over those streams. pi-env's own `Connection` starts the
daemon through `node:child_process`, which a Worker does not have; the protocol and `RemoteExecutionEnv`
are pi-env's own.

The grant is `sandbox:<session>:execute` (or `sandbox:*:execute`) for a principal that is allowed the
session. The model cannot name another session's container.

## Network and credentials

The container has open outbound internet, so `npm install`, `apt-get` and tests that fetch things work.
It holds no credential and no Worker secret. Every request it makes goes through `GitHubEgress`
(`egress.ts`), which attaches a GitHub App installation token only to requests for the repositories the
principal holds a `github:<repo|owner/*>:read|write|workflow` grant for (`policy.ts`):

- `api.github.com`, `github.com` (git over HTTPS) and `codeload.github.com` get a token for a granted repo.
- A repository without a grant is reachable as the public internet is: reads without a credential, no writes.
- Every other host passes through unchanged.

The platform's CA is trusted through `SSL_CERT_FILE` and its siblings (`TRUST_ENV`), because every HTTPS
request is intercepted.

## Limits

- A container that stops (inactivity, destroy) restarts from the last snapshot, taken when the daemon ends.
  A snapshot is best effort and only restores onto the same image.
- `bash` is not replay-safe: a session interrupted mid-command does not rerun it.
- Real container behaviour (daemon install, TLS interception, snapshots) is checked on the deployed Worker, not by unit tests.
