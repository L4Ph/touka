import type { SessionAgent } from './session';
import type { Principal } from '../../shared/contracts';
export interface Env {
  SESSIONS: DurableObjectNamespace<SessionAgent>;
  // JSON array of {token, id, sessions, resources}; secret, never sent to clients.
  TEAM_AUTH?: string;
  MODEL_PROVIDER?: string;
  MODEL_ID?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  CLOUDFLARE_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
}
export type AppEnv = { Bindings: Env; Variables: { principal: Principal } };
