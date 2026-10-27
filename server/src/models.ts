import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Provider } from "@earendil-works/pi-ai/models";
import { configuredProviders } from "./provider-config";
import { operatorProviders } from "./operator-providers";
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
