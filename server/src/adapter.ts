import type { AdapterDependencies, AdapterExecution } from "@remote-agent/adapter-contract";
import type { Env } from "./env";
import { teamAuth } from "./auth";
import { createGitHubAppAuth } from "./tools/github/auth";

export async function executeAdapter(env: Env, request: AdapterExecution) {
  if (!env.ADAPTER_JOBS) throw new Error("delivery_unconfigured");
  return env.ADAPTER_JOBS.getByName(`${request.adapter}:${request.input.sessionId}`).accept(
    request,
  );
}

// Only the composition root knows durable bindings; packages receive narrow capabilities.
export const adapterDependencies: AdapterDependencies = {
  authenticate: teamAuth,
  execute: (env, request) => executeAdapter(env as Env, request),
  submit: (env, input, principal) =>
    (env as Env).SESSIONS.getByName(input.sessionId).submit(input, principal),
  status: (env, adapter, sessionId, operationId) => {
    const jobs = (env as Env).ADAPTER_JOBS;
    if (!jobs) throw new Error("delivery_unconfigured");
    return jobs.getByName(`${adapter}:${sessionId}`).status(operationId);
  },
  github: createGitHubAppAuth,
};
