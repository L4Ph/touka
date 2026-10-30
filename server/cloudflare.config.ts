import type { Wake } from "./src/outbox";
import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";

const name = "touka";
const deliveryQueue = "touka-delivery";

// Only declared secrets receive values from `.env.local` locally, and every declared secret is
// required at deploy. Declare an integration's secrets here when you turn it on: Discord
// (DISCORD_APPLICATION_ID, DISCORD_PUBLIC_KEY, DISCORD_GUILDS, DISCORD_ADMIN_TOKEN), MCP (MCP_SERVERS
// and each header secret), operator providers (MODEL_PROVIDERS), and other model keys
// (ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, the Cloudflare AI Gateway trio).
const secretNames = [
  "TEAM_AUTH",
  "OPENROUTER_API_KEY",
  "TYPESAFE_API_KEY",
  "SLACK_SIGNING_SECRET",
  "SLACK_WORKSPACES",
  "SLACK_ADMIN_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_REPOSITORIES",
  "GITHUB_ACTORS",
  "GITHUB_BOT_LOGIN",
] as const;

// JavaScript runs here, offline, on the Cloudflare-managed `cloudflare/debian-trixie` image that the
// Durable Object names when it starts the container, so no named image or Dockerfile is declared.
const sandbox = defineContainer({
  name: "touka-sandbox",
  schedulingPolicy: "durable-object",
});

export default defineConfig({
  // RADIUS5 Inc. Not a secret; it only selects the account when several are available.
  accountId: "a861edcf31e50df89b431c5ebe6a3019",
  containers: [sandbox],
  worker: {
    name,
    entrypoint: "src/index.ts",
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    observability: { enabled: true },
    exports: {
      PiDurable: exports.durableObject({ storage: "sqlite" }),
      SandboxContainer: exports.durableObject({ storage: "sqlite", container: sandbox }),
    },
    // One message per wake: delivery state is in the PiDurable, the queue only schedules attempts.
    triggers: [
      triggers.queue({ name: deliveryQueue, maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 10 }),
    ],
    env: {
      PI_DURABLE: bindings.durableObject({ worker: name, exportName: "PiDurable" }),
      DELIVERY: bindings.queue<Wake>({ name: deliveryQueue }),
      SANDBOX_CONTAINER: bindings.durableObject({ worker: name, exportName: "SandboxContainer" }),
      ...Object.fromEntries(secretNames.map((secretName) => [secretName, bindings.secret()])),
    },
  },
});
