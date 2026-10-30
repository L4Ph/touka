import { isSubmitInput } from "@remote-agent/agent-contract";
import type { TriggerDependencies, TriggerExecution } from "@remote-agent/trigger-contract";
import type { Env } from "./env";
import { teamAuth } from "./auth";
import { DELIVERY_LIMITS } from "./ledger";
import { addressed } from "./addressed";
import { deliveryHandlers } from "./plugins";

export async function executeTrigger(env: Env, request: TriggerExecution) {
  if (!env.DELIVERY) throw new Error("delivery_unconfigured");
  if (
    !request ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(request.trigger) ||
    !Object.hasOwn(deliveryHandlers(), request.trigger) ||
    !isSubmitInput(request.input) ||
    !request.reply ||
    typeof request.reply !== "object" ||
    Array.isArray(request.reply) ||
    new TextEncoder().encode(JSON.stringify(request.reply)).length > DELIVERY_LIMITS.replyBytes
  )
    throw new Error("invalid_trigger_execution");
  const { sessionId, operationId } = request.input;
  const receipt = await env.PI_DURABLE.getByName(sessionId).accept(request);
  // Sent even for a duplicate, so a crash between accept and send heals on the vendor's retry.
  await env.DELIVERY.send({ sessionId, operationId });
  return receipt;
}

// Only the composition root knows durable bindings; packages receive narrow capabilities.
export const triggerDependencies: TriggerDependencies = {
  authenticate: teamAuth,
  execute: (env, request) => executeTrigger(env as Env, request),
  submit: (env, input, principal) =>
    (env as Env).PI_DURABLE.getByName(input.sessionId).submit(input, principal),
  status: (env, trigger, sessionId, operationId) =>
    (env as Env).PI_DURABLE.getByName(sessionId).deliveryStatus(trigger, operationId),
  exists: async (env, sessionId) =>
    (await (env as Env).PI_DURABLE.getByName(sessionId).summary()) !== null,
  addressed: (env, sample) => addressed(env as Env, sample),
};
