import type { SessionAgent } from "./session";
import type { TriggerEnv } from "@remote-agent/trigger-contract";
import type { Principal } from "@remote-agent/agent-contract";
import type { TriggerJobs } from "./jobs";
import type { SandboxSession } from "./tools/sandbox/worker";
import type { GitHubEnv } from "@remote-agent/connector-github";
export interface Env extends GitHubEnv, TriggerEnv {
  TRIGGER_JOBS?: DurableObjectNamespace<TriggerJobs>;
  SANDBOX?: DurableObjectNamespace<SandboxSession>;
  SESSIONS: DurableObjectNamespace<SessionAgent>;
  // JSON array of {token, id, sessions, resources}; secret, never sent to clients.
  TEAM_AUTH?: string;
  MODEL_PROVIDER?: string;
  MODEL_ID?: string;
  // Server-only JSON ProviderConfig[]. SDK auth resolves arbitrary string bindings.
  MODEL_PROVIDERS?: string;
  MCP_SERVERS?: string;
}
export type AppEnv = { Bindings: Env; Variables: { principal: Principal } };
