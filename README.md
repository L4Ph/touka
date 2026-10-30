# Touka (橙夏)

A headless, durable remote agent that runs on Cloudflare Workers. Slack, GitHub, Discord or a webhook starts the work; Touka answers in the same place, can open pull requests and review code, and keeps each conversation in its own Durable Object.

Built on Pi Durable, pi-ai and Cloudflare Containers.

The name 橙夏 (_tōka_, "orange summer") comes from the orange of Cloudflare and the summer heat of its "flare", with a nod to Hono (炎, "flame").

## Run it

Needs Node 24.11+ and [Vite+](https://viteplus.dev/guide/).

```sh
vp install
cp .env.example server/.env.local   # fill in TEAM_AUTH and a model API key
vp run dev
```

```sh
curl http://localhost:5173/triggers/webhook \
  -H "Authorization: Bearer $AGENT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sessionId":"demo","operationId":"1","input":"Hello"}'
```

## Deploy

```sh
export CLOUDFLARE_ACCOUNT_ID=<your account>
vp run deploy
```

## Configure

- Behavior (instructions, model, retries, compaction): [`server/touka.config.ts`](server/touka.config.ts)
- Slack, GitHub, Discord, MCP: [`.env.example`](.env.example) and each package README under `packages/`
- Deployment, API, models, limits: [docs/operations.md](docs/operations.md)
- How the pieces fit: [docs/connections.md](docs/connections.md)

## Develop

```sh
vp test     # unit tests live in the source files they test
vp check    # format, lint, types
```

## License

[MIT](LICENSE)
