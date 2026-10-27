# GitHub inbound adapter — pending

This package is reserved for the resumed `github-adapter` unit. It currently has no route or delivery handler and does not claim GitHub webhook support.

Implement `src/index.ts`, export it via this package's `exports`, and add a package typecheck script. Server discovery then mounts `create` at `/adapters/github` and registers `deliver` without central edits. Import only `@remote-agent/adapter-contract` and protocol dependencies, never server/core implementation.

Use injected `dependencies.github(env)` / delivery `context.github` for the existing GitHub App installation authentication. Do not duplicate JWT/token code. See `../../server/src/README.md` for execution, status, authorization, retry and crash contracts. This unit owns signature verification, allowed actors/repositories, mention filtering, thread mapping, payload bounds and reply formatting.
