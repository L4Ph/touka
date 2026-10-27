import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import type { Model } from "@earendil-works/pi-ai";

const apis = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
};
export interface ProviderConfig {
  id: string;
  name?: string;
  api: keyof typeof apis;
  baseUrl: string;
  auth: { env: string } | { keyless: true };
  models: Omit<Model<keyof typeof apis>, "provider" | "api" | "baseUrl">[];
}

function invalid(): never {
  // Never include configuration values: endpoints and metadata can be private.
  throw new Error("invalid_provider_config");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2048;
}
function positive(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function configuredProviders(raw: string | undefined): Provider[] {
  if (raw === undefined || raw === "") return [];
  if (typeof raw !== "string" || raw.length > 131072) invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    invalid();
  }
  if (!Array.isArray(parsed) || parsed.length > 32) invalid();
  const ids = new Set<string>();
  return parsed.map((entry: unknown) => {
    const config = object(entry);
    keys(config, ["id", "name", "api", "baseUrl", "auth", "models"]);
    if (!text(config.id) || ids.has(config.id) || !/^[a-zA-Z0-9_-]+$/.test(config.id)) invalid();
    ids.add(config.id);
    if (config.name !== undefined && !text(config.name)) invalid();
    if (typeof config.api !== "string" || !Object.hasOwn(apis, config.api)) invalid();
    if (!text(config.baseUrl)) invalid();
    let url: URL;
    try {
      url = new URL(config.baseUrl);
    } catch {
      invalid();
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      invalid();
    const auth = object(config.auth);
    keys(auth, ["env", "keyless"]);
    if (
      !(
        Object.keys(auth).length === 1 &&
        ((typeof auth.env === "string" && /^[A-Z][A-Z0-9_]*$/.test(auth.env)) ||
          auth.keyless === true)
      )
    )
      invalid();
    if (!Array.isArray(config.models) || !config.models.length || config.models.length > 256)
      invalid();
    const modelIds = new Set<string>();
    for (const value of config.models) {
      const model = object(value);
      keys(model, [
        "id",
        "name",
        "reasoning",
        "input",
        "cost",
        "contextWindow",
        "maxTokens",
        "compat",
      ]);
      if (
        !text(model.id) ||
        modelIds.has(model.id) ||
        !text(model.name) ||
        typeof model.reasoning !== "boolean" ||
        !positive(model.contextWindow) ||
        !positive(model.maxTokens) ||
        !Array.isArray(model.input) ||
        !model.input.length ||
        model.input.some((v) => v !== "text" && v !== "image")
      )
        invalid();
      modelIds.add(model.id);
      const cost = object(model.cost);
      keys(cost, ["input", "output", "cacheRead", "cacheWrite"]);
      if (
        ["input", "output", "cacheRead", "cacheWrite"].some(
          (k) => typeof cost[k] !== "number" || !Number.isFinite(cost[k]) || cost[k] < 0,
        )
      )
        invalid();
      if (model.compat !== undefined) {
        const compat = object(model.compat);
        keys(compat, [
          "supportsDeveloperRole",
          "supportsReasoningEffort",
          "supportsStore",
          "supportsUsageInStreaming",
          "maxTokensField",
        ]);
        if (
          Object.entries(compat).some(([k, v]) =>
            k === "maxTokensField"
              ? v !== "max_tokens" && v !== "max_completion_tokens"
              : typeof v !== "boolean",
          )
        )
          invalid();
      }
    }
    const typed = config as unknown as ProviderConfig;
    return createProvider({
      id: typed.id,
      name: typed.name,
      baseUrl: typed.baseUrl,
      auth:
        "env" in typed.auth
          ? { apiKey: envApiKeyAuth(typed.id, [typed.auth.env]) }
          : { apiKey: { name: typed.id, resolve: async () => ({ auth: {} }) } },
      models: typed.models.map((model) => ({
        ...model,
        provider: typed.id,
        api: typed.api,
        baseUrl: typed.baseUrl,
      })),
      api: apis[typed.api](),
    });
  });
}
