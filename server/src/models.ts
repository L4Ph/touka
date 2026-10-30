import type { ProviderConfig } from "./provider-config";
import type nodeAssert from "node:assert/strict";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Provider } from "@earendil-works/pi-ai/models";
import { configuredProviders } from "./provider-config";
import { operatorProviders } from "./operator-providers";
import toukaConfig from "../touka.config";
import type { Env } from "./env";
import type { ModelSelection } from "@remote-agent/agent-contract";

export function sessionModels(env: Env, providers: readonly Provider[] = operatorProviders) {
  const models = builtinModels({
    authContext: {
      fileExists: async () => false,
      env: async (name) => {
        if (!Object.hasOwn(env, name)) return undefined;
        const value: unknown = env[name as keyof Env];
        if (value === undefined || value === "") return undefined;
        if (typeof value !== "string" || value.trim() !== value || /[\r\n\0]/.test(value))
          throw new Error("invalid_provider_secret");
        return value;
      },
    },
  });
  for (const provider of [...configuredProviders(env.MODEL_PROVIDERS), ...providers])
    models.setProvider(provider);
  return models;
}

/**
 * Pi compacts at `contextWindow - reserveTokens`, but its reserve/keep/background token counts
 * are fixed. Scale them to each registered model's own window so a 32k and a 1M model both
 * keep the same proportion of headroom.
 */
export function compactionOverrides(
  models: Pick<ReturnType<typeof sessionModels>, "getModelsOfType">,
  share = { reserve: 0.1, keepRecent: 0.15, background: 0.2 },
) {
  return Object.fromEntries(
    models
      .getModelsOfType("chat")
      .filter((model) => model.contextWindow > 0)
      .map(({ provider, id, contextWindow }) => [
        `${provider}/${id}`,
        {
          reserveTokens: Math.round(contextWindow * share.reserve),
          keepRecentTokens: Math.round(contextWindow * share.keepRecent),
          backgroundTokens: Math.round(contextWindow * share.background),
        },
      ]),
  );
}

export async function modelError(env: Env, selection: ModelSelection): Promise<string | null> {
  try {
    const models = sessionModels(env);
    if (!models.getModel(selection.provider, selection.id)) return "invalid_model";
    if (!(await models.getAuth(selection.provider))) return "model_unconfigured";
    return null;
  } catch {
    return "model_unconfigured";
  }
}

export async function modelCatalog(env: Env) {
  const models = sessionModels(env);
  return Promise.all(
    models.getProviders().map(async (provider) => ({
      provider: provider.id,
      transport: provider.id === "cloudflare-ai-gateway" ? "cloudflare-gateway" : "native",
      configured: Boolean(
        await models.getAuth(provider.id).catch(() => {
          throw new Error("invalid_provider_secret");
        }),
      ),
      models: models.getModels(provider.id).map(({ id, api, name }) => ({ id, api, name })),
    })),
  );
}

/**
 * The model new conversations start with: `touka.config.ts`, unless the environment names a complete
 * other one (tests). Half an override is ignored, so a provider is never paired with another's model.
 */
export function defaultModel(env: Env): ModelSelection {
  return env.MODEL_PROVIDER && env.MODEL_ID
    ? { provider: env.MODEL_PROVIDER, id: env.MODEL_ID }
    : { provider: toukaConfig.model.provider, id: toukaConfig.model.id };
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;

  test("compaction headroom scales with each model's context window", () => {
    const models = {
      getModelsOfType: () => [
        { provider: "p", id: "small", contextWindow: 32_000 },
        { provider: "p", id: "huge", contextWindow: 1_000_000 },
        { provider: "p", id: "unknown", contextWindow: 0 },
      ],
    } as unknown as Parameters<typeof compactionOverrides>[0];
    assert.deepEqual(compactionOverrides(models), {
      "p/small": { reserveTokens: 3200, keepRecentTokens: 4800, backgroundTokens: 6400 },
      "p/huge": { reserveTokens: 100_000, keepRecentTokens: 150_000, backgroundTokens: 200_000 },
    });
  });
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { createProvider } = await import("@earendil-works/pi-ai/models");
  const { openAICompletionsApi } =
    await import("@earendil-works/pi-ai/api/openai-completions.lazy");

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
        {
          systemPrompt: "Be concise",
          messages: [{ role: "user", content: "Hello", timestamp: 1 }],
        },
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
}
