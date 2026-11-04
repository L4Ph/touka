import type nodeAssert from "node:assert/strict";
import type { TriggerExecution } from "@remote-agent/trigger-contract";
import type { OperationStatus } from "@remote-agent/agent-contract";

export interface Delivery extends TriggerExecution {
  state: "waiting" | "delivering" | "delivered" | "failed";
  created: number;
  due: number;
  attempts: number;
  /** Control replies do not wait for a Pi submission. */
  result?: OperationStatus;
  /** Capture at acceptance so a retried stop never aborts work submitted later. */
  stopTargets?: string[];
  failure?: { code: string; attempts: number };
}
export const DELIVERY_LIMITS = {
  jobs: 100,
  attempts: 6,
  lifetimeMs: 86_400_000,
  timeoutMs: 20_000,
  replyBytes: 8192,
} as const;
export const backoff = (attempts: number) =>
  Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));

const prefix = "delivery:";
const terminal = (job: Delivery) => job.state === "delivered" || job.state === "failed";
const code = (value: string) => (/^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "delivery_failed");

/** Reply records live beside the Pi conversation they answer, keyed by operation ID. */
export function ledger(storage: DurableObjectStorage) {
  return {
    terminal,
    code,
    get: (operationId: string) => storage.get<Delivery>(prefix + operationId),
    put: (job: Delivery) => storage.put(prefix + job.input.operationId, job),
    async stopping(pending: string[]) {
      const jobs = await storage.list<Delivery>({ prefix });
      return [...jobs.values()].some(
        (job) =>
          job.action === "stop" &&
          !job.result &&
          !terminal(job) &&
          job.stopTargets?.some((target) => pending.includes(target)) &&
          Date.now() - job.created < DELIVERY_LIMITS.lifetimeMs,
      );
    },
    fail(job: Delivery, reason: string) {
      job.state = "failed";
      job.failure = { code: code(reason), attempts: job.attempts };
      return job;
    },
    execution: ({ trigger, action, input, principal, reply }: Delivery): TriggerExecution => ({
      trigger,
      ...(action ? { action } : {}),
      input,
      principal,
      reply,
    }),
    /** Drops expired receipts and returns how many records remain. */
    async prune() {
      const jobs = await storage.list<Delivery>({ prefix });
      for (const [key, job] of jobs)
        if (terminal(job) && Date.now() - job.created > DELIVERY_LIMITS.lifetimeMs) {
          await storage.delete(key);
          jobs.delete(key);
        }
      return jobs.size;
    },
  };
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;

  const job = (operationId: string, overrides: Partial<Delivery> = {}): Delivery => ({
    trigger: "probe",
    input: { sessionId: "s", operationId, input: "hi" },
    principal: { id: "p", sessions: ["s"], resources: [] },
    reply: {},
    state: "waiting",
    created: Date.now(),
    due: 0,
    attempts: 0,
    ...overrides,
  });

  // Just enough of DurableObjectStorage for the ledger.
  function memory() {
    const map = new Map<string, unknown>();
    return {
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => void map.set(key, value),
      delete: async (key: string) => map.delete(key),
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...map].filter(([key]) => key.startsWith(prefix))),
    } as unknown as DurableObjectStorage;
  }

  test("a pending stop fences new work until cancellation settles, not until Slack delivers", async () => {
    const jobs = ledger(memory());
    const stop = job("stop", { action: "stop", stopTargets: ["original"] });
    await jobs.put(stop);
    assert.equal(await jobs.stopping(["original"]), true);
    assert.equal(await jobs.stopping(["later"]), false);
    stop.result = { sessionId: "s", operationId: "stop", status: "done", text: "Stopped." };
    await jobs.put(stop);
    assert.equal(await jobs.stopping(["original"]), false);
    assert.equal((await jobs.get("stop"))?.state, "waiting");
    await jobs.put(
      job("expired-stop", {
        action: "stop",
        stopTargets: ["old"],
        created: Date.now() - DELIVERY_LIMITS.lifetimeMs - 1,
      }),
    );
    assert.equal(await jobs.stopping(["old"]), false);
  });

  test("backoff doubles from one second and caps at one minute", () => {
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7].map(backoff),
      [1000, 2000, 4000, 8000, 16000, 32000, 60000],
    );
  });

  test("fail records a sanitized code and the consumed attempts", () => {
    const failed = ledger(memory()).fail(job("a", { attempts: 3 }), "Bad Code!");
    assert.equal(failed.state, "failed");
    assert.deepEqual(failed.failure, { code: "delivery_failed", attempts: 3 });
  });

  test("prune drops only terminal records older than the lifetime", async () => {
    const jobs = ledger(memory());
    const old = Date.now() - DELIVERY_LIMITS.lifetimeMs - 1;
    await jobs.put(job("old-done", { state: "delivered", created: old }));
    await jobs.put(job("old-waiting", { created: old }));
    await jobs.put(job("fresh-done", { state: "delivered" }));
    assert.equal(await jobs.prune(), 2);
    assert.equal(await jobs.get("old-done"), undefined);
    assert.ok(await jobs.get("old-waiting"));
  });
}
