import { DurableObject } from 'cloudflare:workers';
import { AgentDoc, createRegistry, Harness } from '@earendil-works/pi-durable';
import { sessionModels, modelError } from './models';
import { PiHarness } from 'agents/harness/pi';
import { Lifecycle } from 'agents/lifecycle';
import { sessionStream } from './stream';
import type { Env } from './env';
import { installTools } from './plugins';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { LIMITS, type ModelSelection, type SubmitInput, type SubmitReceipt, type OperationStatus } from '../../shared/contracts';

export class SessionAgent extends DurableObject<Env> {
  private readonly connections = new Set<WebSocket>();

  async fetch(request: Request) {
    return sessionStream(request, this.env, this.ctx, this.harness, this.connections);
  }

  readonly harness = new PiHarness({
    harness: ({ storage, context, onWake }) => {
      const models = sessionModels(this.env);
      const registry = createRegistry();
      // Session access does not grant outbound tool permissions.
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
      await this.ctx.storage.put('created', true);
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

  async create(model?: ModelSelection) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.ctx.storage.get('created')) return { error: 'session_exists' };
      const selection = model ?? (this.env.MODEL_PROVIDER && this.env.MODEL_ID
        ? { provider: this.env.MODEL_PROVIDER, id: this.env.MODEL_ID } : undefined);
      if (!selection) return { error: 'model_unconfigured' };
      const error = await modelError(this.env, selection);
      if (error) return { error };
      await this.harness.session().setModel(selection);
      await this.ctx.storage.put('created', true);
      return { error: null };
    });
  }

  async summary() {
    if (!await this.ctx.storage.get('created')) return null;
    const pi = await this.harness.pi();
    const conversation = await this.harness.conversation('1');
    const agent = await pi.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT);
    return { model: agent?.model ? { provider: agent.model.provider, id: agent.model.modelId } : null,
      busy: await this.harness.session().busy(), pending: await this.harness.pending() };
  }

  async transcript() { return JSON.stringify({ messages: await this.harness.messages() }); }

  async setModel(model: ModelSelection) {
    const error = await modelError(this.env, model);
    if (error) return { error };
    await this.harness.session().setModel(model);
    return { error: null };
  }

  async abort(operationId?: string) { return this.harness.abort({ operationId }); }
  async retry() { return this.harness.retry(); }

  async inspect() {
    const sessions = await this.harness.sessions.list();
    return { sessions, modelConfigured: Boolean(this.env.MODEL_PROVIDER && this.env.MODEL_ID) };
  }
}
