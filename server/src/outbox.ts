import type { OperationStatus } from "@remote-agent/agent-contract";
import type { DeliveryResult, TriggerExecution } from "@remote-agent/trigger-contract";
import type { Env } from "./env";
import { DELIVERY_LIMITS } from "./ledger";
import { deliveryHandlers } from "./plugins";

/** Queue message: only a wake-up. The reply record lives in the PiDurable. */
export interface Wake {
  sessionId: string;
  operationId: string;
  polls?: number;
}
const handlers = deliveryHandlers();
// DO RPC typing erases JSON-shaped fields such as `reply`, so state the shape the PiDurable returns.
type Claim =
  | { action: "stop" }
  | { action: "wait"; delayMs: number }
  | { action: "deliver"; job: TriggerExecution; result: OperationStatus };

/** One lease/deliver/record cycle. Returns the delay before the next wake, or undefined when finished. */
async function step(env: Env, { sessionId, operationId, polls = 0 }: Wake) {
  const session = env.PI_DURABLE.getByName(sessionId);
  const claim = (await session.claimDelivery(operationId, polls)) as Claim;
  if (claim.action !== "deliver") return claim.action === "wait" ? claim.delayMs : undefined;
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
      handlers[claim.job.trigger]({
        env,
        job: claim.job,
        result: claim.result,
        signal: controller.signal,
      }),
      deadline,
    ]);
  } catch {
    outcome = { status: "retry", code: "delivery_transport_failed" };
  } finally {
    clearTimeout(timer);
  }
  const next = await session.finishDelivery(operationId, outcome);
  return next.action === "wait" ? next.delayMs : undefined;
}

export async function consume(batch: MessageBatch<Wake>, env: Env) {
  for (const message of batch.messages) {
    try {
      const delayMs = await step(env, message.body);
      if (delayMs !== undefined)
        await env.DELIVERY!.send(
          { ...message.body, polls: (message.body.polls ?? 0) + 1 },
          { delaySeconds: Math.max(1, Math.ceil(delayMs / 1000)) },
        );
      message.ack();
    } catch {
      // PiDurable RPC or send failed: the record is intact, so let the platform redeliver.
      message.retry({ delaySeconds: 5 });
    }
  }
}
