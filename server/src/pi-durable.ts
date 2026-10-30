import { DurableObject } from "cloudflare:workers";
import {
  AgentDoc,
  createRegistry,
  defineExtension,
  Harness,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import config from "../touka.config";
import { systemPrompt } from "./config";
import { sessionModels, modelError, compactionOverrides, defaultModel } from "./models";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { sessionStream } from "./stream";
import type { Env } from "./env";
import type { Principal } from "@remote-agent/agent-contract";
import { executionGrant } from "./execution";
import { installTools } from "./tools";
import { ledger, backoff, DELIVERY_LIMITS } from "./ledger";
import type { TriggerExecution, DeliveryResult } from "@remote-agent/trigger-contract";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LIMITS,
  validId,
  type ModelSelection,
  type SubmitInput,
  type SubmitReceipt,
  type OperationStatus,
} from "@remote-agent/agent-contract";

export class PiDurable extends DurableObject<Env> {
  private readonly connections = new Set<WebSocket>();
  private execution?: { sessionId: string; principal: Principal };

  async fetch(request: Request) {
    return sessionStream(request, this.env, this.ctx, this.harness, this.connections, () =>
      this.exists(),
    );
  }

  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      this.execution ??= await this.ctx.storage.get("execution");
      const models = sessionModels(this.env);
      const registry = createRegistry();
      // PiHarness must create the root with its model defaults; identity belongs in the registry.
      registry.install({
        name: "touka",
        sections: [{ key: "identity", tag: false, render: () => systemPrompt(config) }],
      });
      if (config.beforeTool) {
        const beforeTool = config.beforeTool;
        registry.install(
          defineExtension({
            name: "touka.policy",
            hooks: [
              hook(ToolTask, {
                beforeTool: (call) => {
                  const block = beforeTool({ name: call.name, arguments: call.arguments });
                  return block ? { block } : undefined;
                },
              }),
            ],
          }),
        );
      }
      const execution = () => this.execution;
      installTools(registry, {
        env: this.env,
        get sessionId() {
          return execution()?.sessionId ?? "";
        },
        get principal() {
          return execution()?.principal ?? { id: "unbound", sessions: [], resources: [] };
        },
      });
      return Harness.open(
        storage,
        {
          models,
          registry,
          onWake,
          settings: {
            retry: { enabled: true, ...config.retry },
            restartLimit: config.restartLimit,
            compaction: { modelOverrides: compactionOverrides(models, config.compaction) },
          },
        },
        context,
      );
    },
    defaults: {
      model: defaultModel(this.env),
      ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
    },
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async submit(input: SubmitInput, principal: Principal): Promise<SubmitReceipt | null> {
    return this.ctx.blockConcurrencyWhile(() => this.enqueue(input, principal));
  }

  private async enqueue(
    { sessionId, operationId, input }: SubmitInput,
    principal: Principal,
  ): Promise<SubmitReceipt | null> {
    const grant = executionGrant(sessionId, principal);
    this.execution ??= await this.ctx.storage.get("execution");
    if (this.execution && JSON.stringify(this.execution) !== JSON.stringify(grant))
      throw new Error("execution_grant_conflict");
    if (!this.execution) {
      // Never grant tools retroactively to an already queued legacy operation.
      if ((await this.harness.pending()).length) throw new Error("execution_grant_conflict");
      await this.ctx.storage.put("execution", grant);
      this.execution = grant;
    }
    const storage = await this.harness.storage();
    const conversation = await this.harness.conversation("1");
    const existing = await storage.submissionByRequest(
      conversation.id,
      operationId,
      BACKGROUND_CONTEXT,
    );
    // A retry must still succeed when the inbox is full.
    if (!existing && (await this.harness.pending()).length >= LIMITS.pending) return null;
    const receipt = await this.harness.submit(input, { operationId });
    await this.ctx.storage.put("created", true);
    return { sessionId, operationId, accepted: receipt.accepted };
  }

  /** Trigger entry: submit to Pi and record the reply destination in one gate. */
  async accept({ trigger, input, principal, reply }: TriggerExecution) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const grant = executionGrant(input.sessionId, principal);
      const jobs = ledger(this.ctx.storage);
      const existing = await jobs.get(input.operationId);
      if (existing) {
        if (
          JSON.stringify([existing.trigger, existing.input, existing.principal, existing.reply]) !==
          JSON.stringify([trigger, input, grant.principal, reply])
        )
          throw new Error("delivery_conflict");
        return { accepted: false, operationId: input.operationId };
      }
      if ((await jobs.prune()) >= DELIVERY_LIMITS.jobs) throw new Error("delivery_queue_full");
      if (!(await this.enqueue(input, principal))) throw new Error("delivery_queue_full");
      const now = Date.now();
      await jobs.put({
        trigger,
        input,
        principal: grant.principal,
        reply,
        state: "waiting",
        created: now,
        due: now,
        attempts: 0,
      });
      return { accepted: true, operationId: input.operationId };
    });
  }

  async deliveryStatus(trigger: string, operationId: string) {
    const job = validId(operationId) && (await ledger(this.ctx.storage).get(operationId));
    return job && job.trigger === trigger
      ? {
          operationId,
          state: job.state,
          attempts: job.attempts,
          due: job.due,
          failure: job.failure ?? null,
        }
      : null;
  }

  /** Queue consumer step 1: lease the next reply attempt, or say how long to wait. */
  async claimDelivery(operationId: string, polls: number) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const jobs = ledger(this.ctx.storage);
      const job = await jobs.get(operationId);
      if (!job || jobs.terminal(job)) return { action: "stop" } as const;
      const now = Date.now();
      if (job.due > now) return { action: "wait", delayMs: job.due - now } as const;
      if (now - job.created >= DELIVERY_LIMITS.lifetimeMs) {
        await jobs.put(jobs.fail(job, "delivery_expired"));
        return { action: "stop" } as const;
      }
      const result = await this.operation(job.input.sessionId, operationId);
      if (!result || !["done", "unanswered", "parked"].includes(result.status))
        // ponytail: queue polling capped at 5s; a long-lived RPC on harness.wait() would avoid it.
        return { action: "wait", delayMs: Math.min(5000, 1000 * 2 ** polls) } as const;
      if (job.attempts >= DELIVERY_LIMITS.attempts) {
        await jobs.put(jobs.fail(job, "delivery_attempts_exhausted"));
        return { action: "stop" } as const;
      }
      // Persist the consumed attempt and a lease before the vendor call, so a crash cannot lose it.
      job.state = "delivering";
      job.attempts++;
      job.due = now + DELIVERY_LIMITS.timeoutMs + 1000;
      await jobs.put(job);
      return { action: "deliver", job: jobs.execution(job), result } as const;
    });
  }

  /** Queue consumer step 2: record the vendor outcome and say when to retry. */
  async finishDelivery(operationId: string, outcome: DeliveryResult) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const jobs = ledger(this.ctx.storage);
      const job = await jobs.get(operationId);
      if (!job || job.state !== "delivering") return { action: "stop" } as const;
      if (outcome.status === "delivered") {
        job.state = "delivered";
        delete job.failure;
        await jobs.put(job);
        return { action: "stop" } as const;
      }
      if (outcome.status === "failed" || job.attempts >= DELIVERY_LIMITS.attempts) {
        await jobs.put(jobs.fail(job, outcome.code));
        return { action: "stop" } as const;
      }
      job.failure = { code: jobs.code(outcome.code), attempts: job.attempts };
      const vendor = Number.isFinite(outcome.retryAfterMs) ? outcome.retryAfterMs! : 0;
      const delayMs = Math.max(backoff(job.attempts), Math.min(3_600_000, Math.max(0, vendor)));
      job.due = Date.now() + delayMs;
      await jobs.put(job);
      return { action: "wait", delayMs } as const;
    });
  }

  async operation(sessionId: string, operationId: string): Promise<OperationStatus | null> {
    const storage = await this.harness.storage();
    const conversation = await this.harness.conversation("1");
    const record = await storage.submissionByRequest(
      conversation.id,
      operationId,
      BACKGROUND_CONTEXT,
    );
    if (!record) return null;
    const pending = (await this.harness.pending()).find((item) => item.operationId === operationId);
    if (pending) return { sessionId, operationId, status: pending.status };
    const result = await this.harness.wait(operationId);
    return {
      sessionId,
      operationId,
      status: result.status,
      ...(result.text !== undefined ? { text: result.text } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
    };
  }

  private async exists() {
    if (await this.ctx.storage.get("created")) return true;
    // M0 sessions predate the `created` flag; Pi opens a root even for read-only probes.
    const storage = await this.harness.storage();
    const conversation = await this.harness.conversation("1");
    const submissions = await storage.scanSubmissions(
      { conversationId: conversation.id },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    );
    if (!submissions.items.length) return false;
    await this.ctx.storage.put("created", true);
    return true;
  }

  async create(model?: ModelSelection) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.exists()) return { error: "session_exists" };
      const selection = model ?? defaultModel(this.env);
      const error = await modelError(this.env, selection);
      if (error) return { error };
      await this.harness.session().setModel(selection);
      await this.ctx.storage.put("created", true);
      return { error: null };
    });
  }

  async summary() {
    if (!(await this.exists())) return null;
    const pi = await this.harness.pi();
    const conversation = await this.harness.conversation("1");
    const agent = await pi.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT);
    return {
      model: agent?.model ? { provider: agent.model.provider, id: agent.model.modelId } : null,
      busy: await this.harness.session().busy(),
      pending: await this.harness.pending(),
    };
  }

  async transcript() {
    return JSON.stringify({ messages: await this.harness.messages() });
  }

  async setModel(model: ModelSelection) {
    const error = await modelError(this.env, model);
    if (error) return { error };
    await this.harness.session().setModel(model);
    return { error: null };
  }

  async abort(operationId?: string) {
    return this.harness.abort({ operationId });
  }
  async retry() {
    return this.harness.retry();
  }

  async inspect() {
    const sessions = await this.harness.sessions.list();
    return {
      sessions,
      modelConfigured: (await modelError(this.env, defaultModel(this.env))) === null,
    };
  }
}
