import { DurableObject } from "cloudflare:workers";
import { isSubmitInput, validId } from "@remote-agent/adapter-contract";
import type { Env } from "./env";
import { executionGrant } from "./execution";
import { createGitHubAppAuth } from "./tools/github/auth";

import type {
  AdapterExecution,
  DeliveryHandler,
  DeliveryResult,
} from "@remote-agent/adapter-contract";
export interface DeliveryJob extends AdapterExecution {
  state: "queued" | "waiting" | "delivering" | "delivered" | "failed";
  created: number;
  due: number;
  attempts: number;
  failure?: { code: string; attempts: number };
}
export const DELIVERY_LIMITS = {
  jobs: 100,
  attempts: 6,
  lifetimeMs: 86_400_000,
  timeoutMs: 20_000,
  replyBytes: 8192,
} as const;
const terminal = (job: DeliveryJob) => job.state === "delivered" || job.state === "failed";
const code = (value: string) => (/^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "delivery_failed");

/** Standalone adapter Workers can host the same durable engine with their own handler registry. */
export function deliveryWorker(handlers: Readonly<Record<string, DeliveryHandler>>) {
  return class DeliveryWorker extends DurableObject<Env> {
    private readonly github = createGitHubAppAuth(this.env);

    async accept(request: AdapterExecution) {
      return this.ctx.blockConcurrencyWhile(async () => {
        if (
          !request ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(request.adapter) ||
          !Object.hasOwn(handlers, request.adapter) ||
          !isSubmitInput(request.input) ||
          !request.reply ||
          typeof request.reply !== "object" ||
          Array.isArray(request.reply) ||
          new TextEncoder().encode(JSON.stringify(request.reply)).length >
            DELIVERY_LIMITS.replyBytes
        )
          throw new Error("invalid_adapter_execution");
        const grant = executionGrant(request.input.sessionId, request.principal);
        const identity = `${request.adapter}:${request.input.sessionId}`;
        const storedIdentity = await this.ctx.storage.get<string>("identity");
        if (storedIdentity && storedIdentity !== identity)
          throw new Error("delivery_identity_conflict");
        const key = `job:${request.input.operationId}`;
        const existing = await this.ctx.storage.get<DeliveryJob>(key);
        if (existing) {
          if (
            JSON.stringify({
              adapter: existing.adapter,
              input: existing.input,
              principal: existing.principal,
              reply: existing.reply,
            }) !==
            JSON.stringify({
              adapter: request.adapter,
              input: request.input,
              principal: grant.principal,
              reply: request.reply,
            })
          )
            throw new Error("delivery_conflict");
          return { accepted: false, operationId: request.input.operationId };
        }
        const jobs = await this.ctx.storage.list<DeliveryJob>({ prefix: "job:" });
        for (const [id, job] of jobs) {
          if (terminal(job) && Date.now() - job.created > DELIVERY_LIMITS.lifetimeMs) {
            await this.ctx.storage.delete(id);
            jobs.delete(id);
          }
        }
        if (jobs.size >= DELIVERY_LIMITS.jobs) throw new Error("delivery_queue_full");
        const now = Date.now();
        const job: DeliveryJob = {
          adapter: request.adapter,
          input: request.input,
          principal: grant.principal,
          reply: request.reply,
          state: "queued",
          created: now,
          due: now,
          attempts: 0,
        };
        // Alarm and job commit together, including a crash immediately after the HTTP ACK.
        await this.ctx.storage.transaction(async (storage) => {
          await storage.put("identity", identity);
          await storage.put(key, job);
          const alarm = await storage.getAlarm();
          await storage.setAlarm(Math.min(alarm ?? now, now));
        });
        return { accepted: true, operationId: request.input.operationId };
      });
    }

    async status(operationId: string) {
      if (!validId(operationId)) return null;
      const job = await this.ctx.storage.get<DeliveryJob>(`job:${operationId}`);
      return job
        ? {
            operationId,
            state: job.state,
            attempts: job.attempts,
            due: job.due,
            failure: job.failure ?? null,
          }
        : null;
    }

    private fail(job: DeliveryJob, reason: string) {
      job.state = "failed";
      job.failure = { code: code(reason), attempts: job.attempts };
    }

    async alarm() {
      return this.ctx.blockConcurrencyWhile(async () => {
        const jobs = await this.ctx.storage.list<DeliveryJob>({ prefix: "job:" });
        for (const [key, job] of jobs) {
          if (terminal(job) || job.due > Date.now()) continue;
          // Persist a wake before every RPC/HTTP boundary. Eviction cannot lose a reply.
          job.due = Date.now() + DELIVERY_LIMITS.timeoutMs + 1000;
          await this.ctx.storage.put(key, job);
          await this.ctx.storage.setAlarm(job.due);
          try {
            if (Date.now() - job.created >= DELIVERY_LIMITS.lifetimeMs)
              this.fail(job, "delivery_expired");
            else {
              const session = this.env.SESSIONS.getByName(job.input.sessionId);
              if (job.state === "queued") {
                const receipt = await session.submit(job.input, job.principal);
                if (receipt) job.state = "waiting";
              }
              if (job.state === "waiting" || job.state === "delivering") {
                const result = await session.operation(job.input.sessionId, job.input.operationId);
                if (result && ["done", "unanswered", "parked"].includes(result.status)) {
                  if (job.attempts >= DELIVERY_LIMITS.attempts)
                    this.fail(job, "delivery_attempts_exhausted");
                  else {
                    job.state = "delivering";
                    job.attempts++;
                    await this.ctx.storage.put(key, job);
                    const controller = new AbortController();
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const deadline = new Promise<never>((_resolve, reject) => {
                      timer = setTimeout(() => {
                        controller.abort();
                        reject(new Error("delivery_timeout"));
                      }, DELIVERY_LIMITS.timeoutMs);
                    });
                    let outcome: DeliveryResult;
                    try {
                      outcome = await Promise.race([
                        handlers[job.adapter]({
                          env: this.env,
                          job,
                          result,
                          signal: controller.signal,
                          github: this.github,
                        }),
                        deadline,
                      ]);
                    } finally {
                      clearTimeout(timer);
                    }
                    if (outcome.status === "delivered") {
                      job.state = "delivered";
                      delete job.failure;
                    } else {
                      job.failure = { code: code(outcome.code), attempts: job.attempts };
                      if (outcome.status === "failed" || job.attempts >= DELIVERY_LIMITS.attempts)
                        this.fail(job, outcome.code);
                      else
                        job.due =
                          Date.now() +
                          Math.max(
                            this.backoff(job),
                            Math.min(
                              3_600_000,
                              Math.max(
                                0,
                                Number.isFinite(outcome.retryAfterMs) ? outcome.retryAfterMs! : 0,
                              ),
                            ),
                          );
                    }
                  }
                } else job.due = Date.now() + 1000;
              } else if (job.state === "queued") job.due = Date.now() + 1000;
            }
          } catch (error) {
            const permanent =
              error instanceof Error &&
              ["execution_forbidden", "execution_grant_conflict"].includes(error.message);
            if (permanent) this.fail(job, "execution_forbidden");
            else if (job.attempts >= DELIVERY_LIMITS.attempts)
              this.fail(job, "delivery_attempts_exhausted");
            else {
              job.failure = { code: "delivery_transport_failed", attempts: job.attempts };
              job.due = Date.now() + this.backoff(job);
            }
          }
          await this.ctx.storage.put(key, job);
          // One job per alarm bounds remote latency even when the whole queue is ready.
          break;
        }
        const pending = [...jobs.values()].filter((job) => !terminal(job));
        if (pending.length)
          await this.ctx.storage.setAlarm(Math.min(...pending.map((job) => job.due)));
        else await this.ctx.storage.deleteAlarm();
      });
    }
    private backoff(job: DeliveryJob) {
      return Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1));
    }
  };
}
