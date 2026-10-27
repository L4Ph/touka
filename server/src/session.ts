import { DurableObject } from 'cloudflare:workers';
import { createModels } from '@earendil-works/pi-ai/models';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import type { Env } from './env';
import { installTools } from './plugins';

export class SessionAgent extends DurableObject<Env> {
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels({ authContext: { fileExists: async () => false, env: async (name) => {
        if (name === 'ANTHROPIC_API_KEY') return this.env.ANTHROPIC_API_KEY;
        if (name === 'OPENAI_API_KEY') return this.env.OPENAI_API_KEY;
        return undefined;
      } } });
      const registry = createRegistry();
      // No grants until the session-control unit persists an authorized owner/resource policy.
      installTools(registry, { env: this.env, sessionId: this.ctx.id.toString(), principal: { id: 'unbound', sessions: [], resources: [] } });
      return Harness.open(storage, { models, registry, onWake, settings: {
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 }, restartLimit: 3,
      } }, context);
    },
    defaults: this.env.MODEL_PROVIDER && this.env.MODEL_ID
      ? { model: { provider: this.env.MODEL_PROVIDER, id: this.env.MODEL_ID } } : undefined,
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async inspect() {
    const sessions = await this.harness.sessions.list();
    return { sessions, modelConfigured: Boolean(this.env.MODEL_PROVIDER && this.env.MODEL_ID) };
  }
}
