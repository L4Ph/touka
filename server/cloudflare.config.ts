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

// New coding sessions start with their tools already installed; existing snapshots retain their image.
const sandbox = defineContainer({
  name: "touka-sandbox",
  schedulingPolicy: "durable-object",
  images: { tools: { dockerfile: "./sandbox.Dockerfile" } },
});

export default defineConfig({
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
      // Every request the container makes goes through here; it is the only holder of GitHub credentials.
      GitHubEgress: exports.worker(),
    },
    // One message per wake: delivery state is in the PiDurable, the queue only schedules attempts.
    triggers: [
      triggers.queue({ name: deliveryQueue, maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 10 }),
    ],
    env: {
      PI_DURABLE: bindings.durableObject({ worker: name, exportName: "PiDurable" }),
      DELIVERY: bindings.queue<Wake>({ name: deliveryQueue }),
      CODEMODE_SANDBOX: bindings.durableObject({
        worker: "touka-codemode",
        exportName: "CodemodeSandbox",
      }),
      AI: bindings.ai(),
      BROWSER: bindings.browser(),
      LOADER: bindings.workerLoader(),
      SANDBOX_CONTAINER: bindings.durableObject({ worker: name, exportName: "SandboxContainer" }),
      ...Object.fromEntries(secretNames.map((secretName) => [secretName, bindings.secret()])),
    },
  },
});
