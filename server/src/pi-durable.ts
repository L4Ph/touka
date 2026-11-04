import { DurableObject } from "cloudflare:workers";
import {
  AgentDoc,
  LiveDoc,
  ConversationBusy,
  ConversationIdle,
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
import { SessionStream } from "./stream";
import { serial } from "./serial";
import { progressText } from "./progress";
import type { Env } from "./env";
import type { Principal } from "@remote-agent/agent-contract";
import { executionGrant } from "./execution";
import { installTools } from "./tools";
import { sandbox } from "./sandbox/env";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { RemoteCodemodeSandbox } from "@earendil-works/pi-codemode/portable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { Browser, browserRun } from "agents/browser";
import { browserTool } from "agents/browser/pi";
import { webSearchTool } from "agents/websearch/pi";
import { webFetchTool } from "agents/webfetch/pi";
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
  private readonly serialized = serial();
  private execution?: { sessionId: string; principal: Principal };
  /** The remote browser keeps its tabs and logins between turns; absent without the binding. */
  private readonly browser = this.env.BROWSER
    ? new Browser({ provider: browserRun(this.env.BROWSER) })
    : undefined;

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
      // Pi's own file and shell tools, run inside the session's container.
      const box = sandbox({
        env: this.env,
        get sessionId() {
          return execution()?.sessionId ?? "";
        },
        get principal() {
          return execution()?.principal ?? { id: "unbound", sessions: [], resources: [] };
        },
      });
      registry.install(createCodingTools());
      const web = [
        ...(this.env.AI
          ? [
              webSearchTool({ binding: this.env.AI, provider: "exa" }),
              webFetchTool({ binding: this.env.AI }),
            ]
          : []),
        ...(this.browser && this.env.LOADER
          ? [browserTool({ browser: this.browser, loader: this.env.LOADER, ctx: this.ctx })]
          : []),
      ];
      registry.install({ name: "web", tools: web });
      // Scripts call the tools above as `tools.<name>()`; the VM itself runs in its own Worker.
      const codemode = this.env.CODEMODE_SANDBOX;
      const session = () => execution()?.sessionId ?? "";
      if (codemode)
        registry.install(
          createCodemodeExtension({
            sandbox: new RemoteCodemodeSandbox({
              timeoutMs: 120_000,
              remote: () => codemode.getByName(session()),
            }),
          }),
        );
      return Harness.open(
        storage,
        {
          models,
          registry,
          onWake,
          env: () => box.env(),
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
  readonly stream = new SessionStream(this.ctx, this.env, this.harness, () => this.exists());
  readonly lifecycle = this.browser
    ? Lifecycle.install(this).use(this.browser).use(this.harness).use(this.stream)
    : Lifecycle.install(this).use(this.harness).use(this.stream);

  async submit(input: SubmitInput, principal: Principal): Promise<SubmitReceipt | null> {
    return this.serialized(() => this.enqueue(input, principal));
  }

  private async enqueue(
    { sessionId, operationId, input }: SubmitInput,
    principal: Principal,
    action?: "continue" | "steer",
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
    const pending = await this.harness.pending();
    // A stop cancels shared runs: prevent later inputs from joining before its captured targets settle.
    if (
      !existing &&
      (await ledger(this.ctx.storage).stopping(pending.map((item) => item.operationId)))
    )
      throw new Error("session_stopping");
    // A retry must still succeed when the inbox is full.
    if (!existing && pending.length >= LIMITS.pending) return null;
    await conversation.configure({ maxTurns: config.maxTurns }, BACKGROUND_CONTEXT);
    const receipt =
      action === "continue"
        ? await this.harness.continue({ operationId })
        : await this.harness.submit(input, {
            operationId,
            ...(action === "steer" ? ({ whenBusy: "steer", whenIdle: "reject" } as const) : {}),
          });
    await this.ctx.storage.put("created", true);
    return { sessionId, operationId, accepted: receipt.accepted };
  }

  /** Trigger entry: submit to Pi and record the reply destination in one gate. */
  async accept({ trigger, action, input, principal, reply }: TriggerExecution) {
    return this.serialized(async () => {
      const grant = executionGrant(input.sessionId, principal);
      const jobs = ledger(this.ctx.storage);
      const existing = await jobs.get(input.operationId);
      if (existing) {
        if (
          JSON.stringify([
            existing.trigger,
            existing.action,
            existing.input,
            existing.principal,
            existing.reply,
          ]) !== JSON.stringify([trigger, action, input, grant.principal, reply])
        )
          throw new Error("delivery_conflict");
        return { accepted: false, operationId: input.operationId };
      }
      if ((await jobs.prune()) >= DELIVERY_LIMITS.jobs) throw new Error("delivery_queue_full");
      let result: OperationStatus | undefined;
      let stopTargets: string[] | undefined;
      if (action === "stop") {
        if (!(await this.exists())) throw new Error("session_not_found");
        stopTargets = (await this.harness.pending()).map((item) => item.operationId);
      } else if (action === "status") {
        if (!(await this.exists())) throw new Error("session_not_found");
        const pi = await this.harness.pi();
        const conversation = await this.harness.conversation("1");
        result = {
          sessionId: input.sessionId,
          operationId: input.operationId,
          status: "done",
          text: progressText(await pi.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT)),
        };
      } else {
        try {
          if (!(await this.enqueue(input, principal, action)))
            throw new Error("delivery_queue_full");
        } catch (error) {
          const stopping = error instanceof Error && error.message === "session_stopping";
          if (
            !stopping &&
            !(error instanceof ConversationBusy || error instanceof ConversationIdle)
          )
            throw error;
          result = {
            sessionId: input.sessionId,
            operationId: input.operationId,
            status: "done",
            text: stopping
              ? "A stop is in progress. Wait for its confirmation, then send your request again."
              : error instanceof ConversationBusy
                ? "Work is already running. Use !steer followed by an instruction to change direction."
                : "No task is running to steer. Send a new request, or use !continue after a failed run.",
          };
        }
      }
      const now = Date.now();
      await jobs.put({
        trigger,
        ...(action ? { action } : {}),
        ...(result ? { result } : {}),
        ...(stopTargets ? { stopTargets } : {}),
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
          progressFailure: job.progressFailure ?? null,
        }
      : null;
  }

  /** Queue consumer step 1: lease the next reply attempt, or say how long to wait. */
  async claimDelivery(operationId: string, polls: number, progressTriggers: string[] = []) {
    return this.serialized(async () => {
      const jobs = ledger(this.ctx.storage);
      const job = await jobs.get(operationId);
      if (!job || jobs.terminal(job)) return { action: "stop" } as const;
      const now = Date.now();
      if (job.due > now) return { action: "wait", delayMs: job.due - now } as const;
      if (now - job.created >= DELIVERY_LIMITS.lifetimeMs) {
        await jobs.put(jobs.fail(job, "delivery_expired"));
        return { action: "stop" } as const;
      }
      if (job.action === "stop" && !job.result) {
        job.due = now + DELIVERY_LIMITS.timeoutMs;
        await jobs.put(job);
        return { action: "abort", targets: job.stopTargets ?? [] } as const;
      }
      const result = job.result ?? (await this.operation(job.input.sessionId, operationId));
      if (!result || !["done", "unanswered"].includes(result.status)) {
        if (progressTriggers.includes(job.trigger) && (job.progressDue ?? 0) <= now) {
          job.progressDue = now + DELIVERY_LIMITS.progressIntervalMs;
          await jobs.put(job);
          const pi = await this.harness.pi();
          const conversation = await this.harness.conversation("1");
          const text =
            result?.status === "queued"
              ? "Queued; waiting for active work."
              : progressText(await pi.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT));
          return {
            action: "progress",
            job: jobs.execution(job),
            messageId: job.progressMessageId,
            result: { sessionId: job.input.sessionId, operationId, status: "running", text },
          } as const;
        }
        return { action: "wait", delayMs: Math.min(5000, 1000 * 2 ** polls) } as const;
      }
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

  async finishProgress(operationId: string, outcome: DeliveryResult) {
    return this.serialized(async () => {
      const jobs = ledger(this.ctx.storage);
      const job = await jobs.get(operationId);
      if (!job || jobs.terminal(job)) return { action: "stop" } as const;
      if (outcome.status === "delivered" && outcome.messageId) {
        job.progressMessageId = outcome.messageId;
        job.progressFailures = 0;
        delete job.progressFailure;
      } else {
        job.progressFailures = (job.progressFailures ?? 0) + 1;
        job.progressFailure = jobs.code(
          outcome.status === "delivered" ? "missing_message_receipt" : outcome.code,
        );
        if (outcome.status !== "retry" || job.progressFailures >= DELIVERY_LIMITS.attempts)
          job.progressDue = Number.MAX_SAFE_INTEGER;
        else
          job.progressDue =
            Date.now() +
            Math.min(
              3_600_000,
              Math.max(
                DELIVERY_LIMITS.progressIntervalMs,
                Number.isFinite(outcome.retryAfterMs) ? outcome.retryAfterMs! : 0,
              ),
            );
      }
      await jobs.put(job);
      return { action: "wait", delayMs: 1000 } as const;
    });
  }

  async completeStop(operationId: string) {
    return this.serialized(async () => {
      const jobs = ledger(this.ctx.storage);
      const job = await jobs.get(operationId);
      if (!job || job.action !== "stop" || job.result || jobs.terminal(job)) return;
      job.result = {
        sessionId: job.input.sessionId,
        operationId,
        status: "done",
        text: job.stopTargets?.length
          ? "The operations active when you requested the stop have stopped. Completed changes were not undone. Use !continue to resume."
          : "No active operation needed stopping.",
      };
      job.due = Date.now();
      await jobs.put(job);
    });
  }

  /** Queue consumer step 2: record the vendor outcome and say when to retry. */
  async finishDelivery(operationId: string, outcome: DeliveryResult) {
    return this.serialized(async () => {
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
    const control = await ledger(this.ctx.storage).get(operationId);
    if (control?.result) return control.result;
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
    return this.serialized(async () => {
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
  async continueOperation(operationId: string) {
    return this.serialized(async () => {
      if (!validId(operationId)) return { error: "invalid_operation" } as const;
      if (!(await this.exists())) return { error: "session_not_found" } as const;
      const pending = await this.harness.pending();
      if (await ledger(this.ctx.storage).stopping(pending.map((item) => item.operationId)))
        return { error: "session_busy" } as const;
      try {
        const conversation = await this.harness.conversation("1");
        await conversation.configure({ maxTurns: config.maxTurns }, BACKGROUND_CONTEXT);
        return { receipt: await this.harness.continue({ operationId }) };
      } catch (error) {
        if (error instanceof ConversationBusy) return { error: "session_busy" } as const;
        throw error;
      }
    });
  }

  async inspect() {
    const sessions = await this.harness.sessions.list();
    return {
      sessions,
      modelConfigured: (await modelError(this.env, defaultModel(this.env))) === null,
    };
  }
}
