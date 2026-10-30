# Contributing

Open an issue before a large change. Write code, comments and docs in English.

```sh
vp install
vp run verify   # build, tests, format, lint, types
```

Unit tests go in the source file they test, under `if (import.meta.vitest)`. Read [CONTEXT.md](CONTEXT.md) and [docs/connections.md](docs/connections.md) before changing module responsibilities.
