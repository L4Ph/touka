import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createProvider } from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { sessionModels, modelCatalog, modelError } from "../src/models";
import type { ProviderConfig } from "../src/provider-config";
import type { Env } from "../src/env";
import { globSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Miniflare } from "miniflare";

const localProvider: ProviderConfig = {
  id: "team-inference",
  api: "openai-completions",
  baseUrl: "https://inference.example.test/v1",
  auth: { env: "TEAM_INFERENCE_SECRET" },
  models: [
    {
      id: "team-chat",
      name: "Team Chat",
      reasoning: false,
      input: ["text"],
      contextWindow: 8192,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    },
  ],
};
const selection = { provider: "team-inference", id: "team-chat" };
function serverEnv(values: Record<string, unknown>): Env {
  return values as unknown as Env;
}
function sse() {
  return new Response(
    [
      {
        id: "reply",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Boundary answer" },
            finish_reason: null,
          },
        ],
      },
      {
        id: "reply",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      },
    ]
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    {
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

test("native Groq and operator endpoint serialize through real pi-ai without Gateway credentials", async () => {
  const env = serverEnv({
    GROQ_API_KEY: "groq-server-key",
    TEAM_INFERENCE_SECRET: "operator-secret",
    MODEL_PROVIDERS: JSON.stringify([localProvider]),
  });
  const models = sessionModels(env);
  for (const [provider, id, endpoint, key] of [
    [
      "groq",
      "llama-3.3-70b-versatile",
      "https://api.groq.com/openai/v1/chat/completions",
      "groq-server-key",
    ],
    [
      "team-inference",
      "team-chat",
      "https://inference.example.test/v1/chat/completions",
      "operator-secret",
    ],
  ]) {
    const model = models.getModel(provider, id);
    assert(model, `${provider} must be registered`);
    let requests = 0;
    const result = await models.complete(
      model,
      { systemPrompt: "Be concise", messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      {
        maxTokens: 17,
        fetch: async (input, init) => {
          const request = new Request(input, init);
          assert.equal(request.url, endpoint);
          assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
          const body = (await request.json()) as {
            model: string;
            messages: unknown[];
            stream: boolean;
          };
          assert.equal(body.model, id);
          assert.equal(body.stream, true);
          assert.deepEqual(body.messages, [
            { role: "system", content: "Be concise" },
            { role: "user", content: "Hello" },
          ]);
          requests++;
          return sse();
        },
      },
    );
    assert.equal(result.stopReason, "stop", result.errorMessage ?? "pi-ai request must complete");
    assert.deepEqual(result.content, [{ type: "text", text: "Boundary answer" }]);
    assert.equal(requests, 1, "no implicit rerouting or retry");
  }
  assert.equal(await modelError(env, selection), null);
  assert.equal(await models.getAuth("cloudflare-ai-gateway"), undefined);
  const catalog = await modelCatalog(env);
  assert.deepEqual(
    catalog.find((p) => p.provider === "team-inference"),
    {
      provider: "team-inference",
      transport: "native",
      configured: true,
      models: [{ id: "team-chat", api: "openai-completions", name: "Team Chat" }],
    },
  );
  const publicJson = JSON.stringify(catalog);
  for (const privateValue of [
    "operator-secret",
    "groq-server-key",
    "TEAM_INFERENCE_SECRET",
    "inference.example.test",
  ])
    assert.equal(
      publicJson.includes(privateValue),
      false,
      "catalog must redact server configuration",
    );
});

test("configured keyless providers complete through every JSON-supported pi-ai API without credentials", async () => {
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
    const baseUrl =
      api === "anthropic-messages" ? "https://inference.example.test" : localProvider.baseUrl;
    const env = serverEnv({
      MODEL_PROVIDERS: JSON.stringify([
        { ...localProvider, api, baseUrl, auth: { keyless: true } },
      ]),
      OPENAI_API_KEY: "must-not-be-used",
      ANTHROPIC_API_KEY: "must-not-be-used",
      TEAM_INFERENCE_SECRET: "must-not-be-used",
    });
    assert.equal(await modelError(env, selection), null);
    const models = sessionModels(env);
    const model = models.getModel(selection.provider, selection.id);
    assert(model);
    let requests = 0;
    const result = await models.complete(
      model,
      { messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
      {
        fetch: async (input, init) => {
          requests++;
          const request = new Request(input, init);
          const anthropic = api === "anthropic-messages";
          assert.equal(
            request.url,
            `${baseUrl}/${anthropic ? "v1/messages?beta=true" : api === "openai-responses" ? "responses" : "chat/completions"}`,
          );
          assert.equal(
            request.headers.get(anthropic ? "x-api-key" : "authorization"),
            anthropic ? "keyless" : "Bearer keyless",
          );
          assert.equal(request.headers.get(anthropic ? "authorization" : "x-api-key"), null);
          const body = (await request.json()) as { model: string; stream: boolean };
          assert.equal(body.model, "team-chat");
          assert.equal(body.stream, true);
          if (api === "openai-completions") return sse();
          const events = anthropic
            ? [
                {
                  type: "message_start",
                  message: {
                    id: "reply",
                    type: "message",
                    role: "assistant",
                    content: [],
                    model: "team-chat",
                    usage: { input_tokens: 3, output_tokens: 0 },
                  },
                },
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "Boundary answer" },
                },
                { type: "content_block_stop", index: 0 },
                {
                  type: "message_delta",
                  delta: { stop_reason: "end_turn" },
                  usage: { output_tokens: 2 },
                },
                { type: "message_stop" },
              ]
            : [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: {
                    id: "msg",
                    type: "message",
                    role: "assistant",
                    content: [],
                    status: "in_progress",
                  },
                },
                {
                  type: "response.content_part.added",
                  output_index: 0,
                  content_index: 0,
                  part: { type: "output_text", text: "", annotations: [] },
                },
                {
                  type: "response.output_text.delta",
                  output_index: 0,
                  content_index: 0,
                  delta: "Boundary answer",
                },
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    id: "msg",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "Boundary answer", annotations: [] }],
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: "reply",
                    status: "completed",
                    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
                  },
                },
              ];
          return new Response(
            events
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
            {
              headers: { "Content-Type": "text/event-stream" },
            },
          );
        },
      },
    );
    assert.equal(result.stopReason, "stop", `${api}: ${result.errorMessage}`);
    assert.deepEqual(
      result.content.map((part) => (part.type === "text" ? part.text : part.type)),
      ["Boundary answer"],
    );
    assert.equal(requests, 1, `${api} must reach its configured HTTP endpoint exactly once`);
  }
});

test("SDK Provider registration preserves operator-supplied custom auth", async () => {
  const provider = createProvider({
    id: "sdk-custom",
    auth: { apiKey: { name: "Local", resolve: async () => ({ auth: {} }) } },
    models: [
      {
        ...localProvider.models[0],
        provider: "sdk-custom",
        api: "openai-completions",
        baseUrl: localProvider.baseUrl,
      },
    ],
    api: openAICompletionsApi(),
  });
  const models = sessionModels(serverEnv({}), [provider]);
  assert.equal(models.getModel("sdk-custom", "team-chat")?.contextWindow, 8192);
  assert.deepEqual((await models.getAuth("sdk-custom"))?.auth, {});
});

test("unknown models, missing or malformed arbitrary secrets fail closed with no fallback", async () => {
  const configured = { MODEL_PROVIDERS: JSON.stringify([localProvider]) };
  assert.equal(await modelError(serverEnv(configured), selection), "model_unconfigured");
  for (const value of [42, {}, " secret", "secret\nheader", "secret\0value"]) {
    const env = serverEnv({ ...configured, TEAM_INFERENCE_SECRET: value });
    assert.equal(await modelError(env, selection), "model_unconfigured");
    await assert.rejects(modelCatalog(env), /invalid_provider_secret/);
  }
  assert.equal(
    await modelError(serverEnv({ ...configured, TEAM_INFERENCE_SECRET: "valid" }), {
      provider: "unknown",
      id: "team-chat",
    }),
    "invalid_model",
  );
  assert.equal(
    await modelError(serverEnv(configured), { provider: "groq", id: "unknown" }),
    "invalid_model",
  );
  const inherited = Object.create({ TEAM_INFERENCE_SECRET: "not-an-own-binding" });
  inherited.MODEL_PROVIDERS = configured.MODEL_PROVIDERS;
  assert.equal(await modelError(inherited, selection), "model_unconfigured");
});

test("malformed operator configuration is rejected rather than ignored or partially registered", async () => {
  for (const raw of [
    "{",
    "null",
    "{}",
    JSON.stringify([localProvider, localProvider]),
    ...[
      { api: "unknown" },
      { baseUrl: "file:///etc/passwd" },
      { baseUrl: "https://user:secret@example.test" },
      { auth: { env: "secret-name" } },
      { auth: { env: "KEY", keyless: true } },
      { auth: {} },
      { models: [] },
      { endpoint: "https://unrecognized.test" },
      { models: [{ ...localProvider.models[0], maxTokens: -1 }] },
      { models: [{ ...localProvider.models[0], cost: { input: -1 } }] },
      { models: [{ ...localProvider.models[0], headers: { authorization: "inline-secret" } }] },
    ].map((patch) => JSON.stringify([{ ...localProvider, ...patch }])),
  ]) {
    const env = serverEnv({ MODEL_PROVIDERS: raw, TEAM_INFERENCE_SECRET: "valid" });
    assert.throws(() => sessionModels(env), /invalid_provider_config/);
    assert.equal(await modelError(env, selection), "model_unconfigured");
  }
});

test(
  "authenticated sessions persist an operator model across restart; browser configuration is rejected",
  { timeout: 20000 },
  async () => {
    const state = await mkdtemp(join(tmpdir(), "operator-models-"));
    const token = "operator-models-local-token-000000000000";
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const dist = join(import.meta.dirname, "../dist/remote_agent_server");
    const options = {
      modules: [join(dist, "index.js"), ...globSync(join(dist, "assets/*.js"))].map((path) => ({
        type: "ESModule" as const,
        path,
      })),
      compatibilityDate: "2026-08-01",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { SESSIONS: { className: "SessionAgent", useSQLite: true } },
      durableObjectsPersist: state,
      bindings: {
        TEAM_AUTH: JSON.stringify([{ id: "owner", token, sessions: ["custom"], resources: [] }]),
        MODEL_PROVIDER: "groq",
        MODEL_ID: "llama-3.3-70b-versatile",
        GROQ_API_KEY: "native-key",
        MODEL_PROVIDERS: JSON.stringify([localProvider]),
        TEAM_INFERENCE_SECRET: "private-server-secret",
      },
    };
    let runtime = new Miniflare(options);
    try {
      let url = await runtime.ready;
      const unauthenticated = await fetch(new URL("/api/models", url));
      assert.equal(unauthenticated.status, 401);
      const created = await fetch(new URL("/api/sessions", url), {
        method: "POST",
        headers,
        body: JSON.stringify({ sessionId: "custom" }),
      });
      assert.equal(created.status, 201);
      const update = (body: unknown) =>
        fetch(new URL("/api/sessions/custom/model", url), {
          method: "PUT",
          headers,
          body: JSON.stringify(body),
        });
      assert.equal(
        (
          await update({
            ...selection,
            baseUrl: "https://browser-controlled.test",
            apiKey: "browser-secret",
          })
        ).status,
        400,
      );
      assert.equal((await update({ provider: "not-registered", id: "team-chat" })).status, 400);
      assert.equal((await update(selection)).status, 200);
      const catalogResponse = await fetch(new URL("/api/models", url), { headers });
      assert.equal(catalogResponse.status, 200);
      const catalogText = await catalogResponse.text();
      assert.equal(catalogText.includes("private-server-secret"), false);
      assert.equal(catalogText.includes("inference.example.test"), false);
      assert.equal(
        JSON.parse(catalogText).providers.find(
          (p: { provider: string }) => p.provider === "team-inference",
        ).configured,
        true,
      );
      await runtime.dispose();
      runtime = new Miniflare(options);
      url = await runtime.ready;
      const summary = await fetch(new URL("/api/sessions/custom", url), { headers });
      assert.equal(summary.status, 200);
      assert.deepEqual(((await summary.json()) as { model: unknown }).model, selection);
    } finally {
      await runtime.dispose();
      await rm(state, { recursive: true, force: true });
    }
  },
);
