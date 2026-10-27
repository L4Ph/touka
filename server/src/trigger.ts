import type { TriggerDependencies, TriggerExecution } from "@remote-agent/trigger-contract";
import type { Env } from "./env";
import { teamAuth } from "./auth";

export async function executeTrigger(env: Env, request: TriggerExecution) {
  if (!env.TRIGGER_JOBS) throw new Error("delivery_unconfigured");
  return env.TRIGGER_JOBS.getByName(`${request.trigger}:${request.input.sessionId}`).accept(
    request,
  );
}

// Only the composition root knows durable bindings; packages receive narrow capabilities.
export const triggerDependencies: TriggerDependencies = {
  authenticate: teamAuth,
  execute: (env, request) => executeTrigger(env as Env, request),
  submit: (env, input, principal) =>
    (env as Env).SESSIONS.getByName(input.sessionId).submit(input, principal),
  status: (env, trigger, sessionId, operationId) => {
    const jobs = (env as Env).TRIGGER_JOBS;
    if (!jobs) throw new Error("delivery_unconfigured");
    return jobs.getByName(`${trigger}:${sessionId}`).status(operationId);
  },
};
