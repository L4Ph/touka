import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { cloudflareAIGatewayProvider } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway';
import type { Env } from './env';
import type { ModelSelection } from '../../shared/contracts';

export function sessionModels(env: Env) {
  const values: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENAI_API_KEY: env.OPENAI_API_KEY,
    CLOUDFLARE_API_KEY: env.CLOUDFLARE_API_KEY, CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_GATEWAY_ID: env.CLOUDFLARE_GATEWAY_ID,
  };
  const models = createModels({ authContext: { fileExists: async () => false, env: async (name) => values[name] } });
  models.setProvider(anthropicProvider());
  models.setProvider(openaiProvider());
  models.setProvider(cloudflareAIGatewayProvider());
  return models;
}

export async function modelError(env: Env, selection: ModelSelection): Promise<string | null> {
  const models = sessionModels(env);
  if (!models.getModel(selection.provider, selection.id)) return 'invalid_model';
  if (!await models.getAuth(selection.provider)) return 'model_unconfigured';
  return null;
}

export async function modelCatalog(env: Env) {
  const models = sessionModels(env);
  return Promise.all(models.getProviders().map(async (provider) => ({
    provider: provider.id,
    transport: provider.id === 'cloudflare-ai-gateway' ? 'cloudflare-gateway' : 'native',
    configured: Boolean(await models.getAuth(provider.id)),
    models: models.getModels(provider.id).map(({ id, api, name }) => ({ id, api, name })),
  })));
}
