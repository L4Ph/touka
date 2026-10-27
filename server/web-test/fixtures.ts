import assert from "node:assert/strict";
import { globSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { Miniflare, Response as WorkerResponse } from "miniflare";

const modules = (directory: string) =>
  [`${directory}/index.js`, ...globSync(`${directory}/assets/*.js`)].map((path) => ({
    type: "ESModule" as const,
    path,
  }));
const model = "claude-sonnet-4-5";
export function reply(tool = false) {
  const events = [
    {
      type: "message_start",
      message: {
        id: "web",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: tool
        ? { type: "tool_use", id: "read", name: "github_read_file", input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: tool
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify({ repo: "owner/repo", path: "README.md", ref: "main" }),
          }
        : { type: "text_delta", text: "Mandarin local response" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

export function webRuntimeOptions(
  state: string,
  outboundService: (request: Request) => Promise<WorkerResponse>,
): ConstructorParameters<typeof Miniflare>[0] {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    host: "localhost",
    https: true,
    durableObjectsPersist: join(state, "do"),
    d1Persist: join(state, "d1"),
    workers: [
      {
        name: "web",
        modulesRoot: resolve(".."),
        modules: modules("../dist/ssr"),
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        assets: {
          directory: "../dist/client",
          binding: "ASSETS",
          routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
        },
        d1Databases: { DB: "web-auth" },
        bindings: {
          BETTER_AUTH_SECRET: "web-test-auth-secret-at-least-thirty-two",
          AUTH_GITHUB_CLIENT_ID: "fake-client",
          AUTH_GITHUB_CLIENT_SECRET: "fake-secret",
          TEAM_EMAILS: "alice@example.com,bob@example.com",
        },
        serviceBindings: { AGENT_CORE: { name: "core", entrypoint: "WebGateway" } },
        outboundService: async (request: Request) => {
          const url = new URL(request.url);
          if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token")
            return WorkerResponse.json({
              access_token: new URLSearchParams(await request.text()).get("code"),
              token_type: "bearer",
              scope: "user:email",
            });
          assert.equal(url.hostname, "api.github.com");
          const name = request.headers.get("authorization")!.replace(/^Bearer /i, "");
          if (url.pathname === "/user")
            return WorkerResponse.json({
              id: name === "alice" ? 1 : 2,
              login: name,
              name,
              email: `${name}@example.com`,
            });
          assert.equal(url.pathname, "/user/emails");
          return WorkerResponse.json([
            { email: `${name}@example.com`, primary: true, verified: true },
          ]);
        },
      },
      {
        name: "core",
        modules: modules("dist/remote_agent_server"),
        compatibilityDate: "2026-08-01",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          SESSIONS: { className: "SessionAgent", useSQLite: true },
          SESSION_DIRECTORY: { className: "SessionDirectory", useSQLite: true },
          TRIGGER_JOBS: { className: "TriggerJobs", useSQLite: true },
        },
        bindings: {
          TEAM_AUTH: JSON.stringify([
            {
              id: "trigger",
              token: "web-test-machine-token-at-least-32-characters",
              sessions: ["discord_team_thread"],
              resources: [],
            },
          ]),
          MODEL_PROVIDER: "anthropic",
          MODEL_ID: model,
          ANTHROPIC_API_KEY: "fake-model-key",
          OPENAI_API_KEY: "fake-second-provider-key",
          WEB_RESOURCES: '["github:owner/repo:read"]',
          GITHUB_APP_ID: "123",
          GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
          GITHUB_REPOSITORIES: '{"owner/repo":42}',
        },
        outboundService,
      },
    ],
  };
}
