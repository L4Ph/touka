import type { PiDurable } from "./pi-durable";
import type { TriggerEnv } from "@remote-agent/trigger-contract";
import type { Principal } from "@remote-agent/agent-contract";
import type { Wake } from "./outbox";
import type { SandboxContainer } from "./tools/sandbox/worker";
import type { GitHubEnv } from "@remote-agent/connector-github";
export interface Env extends GitHubEnv, TriggerEnv {
  DELIVERY?: Queue<Wake>;
  SANDBOX_CONTAINER?: DurableObjectNamespace<SandboxContainer>;
  PI_DURABLE: DurableObjectNamespace<PiDurable>;
  // JSON array of {token, id, sessions, resources}; secret, never sent to clients.
  TEAM_AUTH?: string;
  // Optional overrides of `touka.config.ts` `model`; not declared in production, used by tests.
  MODEL_PROVIDER?: string;
  MODEL_ID?: string;
  // Server-only JSON ProviderConfig[]. SDK auth resolves arbitrary string bindings.
  MODEL_PROVIDERS?: string;
  MCP_SERVERS?: string;
}
export type AppEnv = { Bindings: Env; Variables: { principal: Principal } };
