import type { SessionAgent } from "./session";
import type { AdapterEnv, Principal } from "@remote-agent/adapter-contract";
import type { AdapterJobs } from "./jobs";
import type { SandboxSession } from "./tools/sandbox/worker";
import type { GitHubEnv } from "./tools/github/auth";
export interface Env extends GitHubEnv, AdapterEnv {
  ADAPTER_JOBS?: DurableObjectNamespace<AdapterJobs>;
  SANDBOX?: DurableObjectNamespace<SandboxSession>;
  SESSIONS: DurableObjectNamespace<SessionAgent>;
  // JSON array of {token, id, sessions, resources}; secret, never sent to clients.
  TEAM_AUTH?: string;
  MODEL_PROVIDER?: string;
  MODEL_ID?: string;
  // Server-only JSON ProviderConfig[]. SDK auth resolves arbitrary string bindings.
  MODEL_PROVIDERS?: string;
}
export type AppEnv = { Bindings: Env; Variables: { principal: Principal } };
