import { DurableObject } from "cloudflare:workers";
import { AgentDoc, createRegistry, Harness } from "@earendil-works/pi-durable";
import { sessionModels, modelError } from "./models";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { sessionStream } from "./stream";
import type { Env } from "./env";
import type { Principal } from "@remote-agent/adapter-contract";
import { executionGrant } from "./execution";
import { installTools } from "./plugins";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LIMITS,
  type ModelSelection,
  type SubmitInput,
  type SubmitReceipt,
  type OperationStatus,
} from "@remote-agent/adapter-contract";

export class SessionAgent extends DurableObject<Env> {
  private readonly connections = new Set<WebSocket>();
  private execution?: { sessionId: string; principal: Principal };

  async fetch(request: Request) {
    const url = new URL(request.url);
    const internal = /^\/internal\/web\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (internal) {
      url.pathname = `/api/sessions/${internal[1]}/events`;
      return sessionStream(
        new Request(url, request),
        this.env,
        this.ctx,
        this.harness,
        this.connections,
        () => this.exists(),
        internal[1],
      );
    }
    return sessionStream(request, this.env, this.ctx, this.harness, this.connections, () =>
      this.exists(),
    );
  }

  async submitShared(input: SubmitInput) {
    this.execution ??= await this.ctx.storage.get("execution");
    const resources: unknown = JSON.parse(this.env.WEB_RESOURCES ?? "[]");
    if (!Array.isArray(resources) || !resources.every((value) => typeof value === "string"))
      throw new Error("execution_forbidden");
    // Shared visibility never replaces or widens the durable server-granted tool authority.
    return this.submit(
      input,
      this.execution?.principal ?? {
        id: "team-web",
        sessions: [input.sessionId],
        resources,
      },
    );
  }

  private async register(sessionId: string) {
    await this.env.SESSION_DIRECTORY?.getByName("team").register(sessionId);
  }

  readonly harness = new PiHarness({
    harness: async ({ storage, context, onWake }) => {
      this.execution ??= await this.ctx.storage.get("execution");
      const models = sessionModels(this.env);
      const registry = createRegistry();
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
      const pi = await Harness.open(
        storage,
        {
          models,
          registry,
          onWake,
          settings: {
            retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 },
            restartLimit: 3,
          },
        },
        context,
      );
      await pi.root(context, {
        agent: { instructions: "You are Mandarin, a general-purpose assistant. Help the team with their tasks." },
      });
      return pi;
    },
    defaults:
      this.env.MODEL_PROVIDER && this.env.MODEL_ID
        ? { model: { provider: this.env.MODEL_PROVIDER, id: this.env.MODEL_ID } }
        : undefined,
  });
  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  async submit(
    { sessionId, operationId, input }: SubmitInput,
    principal: Principal,
  ): Promise<SubmitReceipt | null> {
    return this.ctx.blockConcurrencyWhile(async () => {
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
      await this.register(sessionId);
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
    // Pi opens a root even for read-only probes; only durable submissions establish an M0 session.
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

  async create(model?: ModelSelection, sessionId?: string) {
    return this.ctx.blockConcurrencyWhile(async () => {
      if (await this.exists()) return { error: "session_exists" };
      const selection =
        model ??
        (this.env.MODEL_PROVIDER && this.env.MODEL_ID
          ? { provider: this.env.MODEL_PROVIDER, id: this.env.MODEL_ID }
          : undefined);
      if (!selection) return { error: "model_unconfigured" };
      const error = await modelError(this.env, selection);
      if (error) return { error };
      if (sessionId) await this.register(sessionId);
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
    return { sessions, modelConfigured: Boolean(this.env.MODEL_PROVIDER && this.env.MODEL_ID) };
  }
}
