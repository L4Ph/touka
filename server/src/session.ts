import { DurableObject } from 'cloudflare:workers';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import type { Env } from './env';
import { installTools } from './plugins';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { LIMITS, type SubmitInput, type SubmitReceipt, type OperationStatus } from '../../shared/contracts';

export class SessionAgent extends DurableObject<Env> {
  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = createModels({ authContext: { fileExists: async () => false, env: async (name) => {
        if (name === 'ANTHROPIC_API_KEY') return this.env.ANTHROPIC_API_KEY;
        if (name === 'OPENAI_API_KEY') return this.env.OPENAI_API_KEY;
        return undefined;
      } } });
      models.setProvider(anthropicProvider());
      models.setProvider(openaiProvider());
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

  async submit({ sessionId, operationId, input }: SubmitInput): Promise<SubmitReceipt | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
      const storage = await this.harness.storage();
      const conversation = await this.harness.conversation('1');
      const existing = await storage.submissionByRequest(conversation.id, operationId, BACKGROUND_CONTEXT);
      // A retry must still succeed when the inbox is full.
      if (!existing && (await this.harness.pending()).length >= LIMITS.pending) return null;
      const receipt = await this.harness.submit(input, { operationId });
      return { sessionId, operationId, accepted: receipt.accepted };
    });
  }

  async operation(sessionId: string, operationId: string): Promise<OperationStatus | null> {
    const storage = await this.harness.storage();
    const conversation = await this.harness.conversation('1');
    const record = await storage.submissionByRequest(conversation.id, operationId, BACKGROUND_CONTEXT);
    if (!record) return null;
    const pending = (await this.harness.pending()).find((item) => item.operationId === operationId);
    if (pending) return { sessionId, operationId, status: pending.status };
    const result = await this.harness.wait(operationId);
    return { sessionId, operationId, status: result.status, ...result.text !== undefined ? { text: result.text } : {},
      ...result.reason !== undefined ? { reason: result.reason } : {} };
  }

  async inspect() {
    const sessions = await this.harness.sessions.list();
    return { sessions, modelConfigured: Boolean(this.env.MODEL_PROVIDER && this.env.MODEL_ID) };
  }
}
