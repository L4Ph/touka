import type { Hono, MiddlewareHandler } from "hono";
import type {
  Principal,
  SubmitInput,
  SubmitReceipt,
  OperationStatus,
} from "@remote-agent/agent-contract";

export interface TriggerExecution {
  trigger: string;
  input: SubmitInput;
  principal: Principal;
  /** Trigger-owned destination/audit data. Never passed to Pi. */
  reply: Record<string, unknown>;
}
export interface TriggerEnv {
  TEAM_AUTH?: string;
  DISCORD_APPLICATION_ID?: string;
  DISCORD_PUBLIC_KEY?: string;
  DISCORD_GUILDS?: string;
  DISCORD_ADMIN_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_WORKSPACES?: string;
  SLACK_ADMIN_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  GITHUB_ACTORS?: string;
  GITHUB_BOT_LOGIN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_REPOSITORIES?: string;
}
export type TriggerAppEnv = { Bindings: TriggerEnv; Variables: { principal: Principal } };
export interface DeliveryContext {
  env: TriggerEnv;
  job: TriggerExecution;
  result: OperationStatus;
  signal: AbortSignal;
}
export type DeliveryResult =
  | { status: "delivered" }
  | { status: "retry" | "failed"; code: string; retryAfterMs?: number };
export type DeliveryHandler = (context: DeliveryContext) => Promise<DeliveryResult>;
export interface TriggerDependencies {
  authenticate: MiddlewareHandler<TriggerAppEnv>;
  submit(env: TriggerEnv, input: SubmitInput, principal: Principal): Promise<SubmitReceipt | null>;
  execute(
    env: TriggerEnv,
    request: TriggerExecution,
  ): Promise<{ accepted: boolean; operationId: string }>;
  status(
    env: TriggerEnv,
    trigger: string,
    sessionId: string,
    operationId: string,
  ): Promise<DeliveryStatus | null>;
  /** Whether the agent already has a conversation for this session, e.g. it has answered in the thread. */
  exists?(env: TriggerEnv, sessionId: string): Promise<boolean>;
  /** Whether the latest message of a conversation is meant for the agent, judged without running it. */
  addressed?(env: TriggerEnv, conversation: ConversationSample): Promise<boolean>;
}
/** A short, ordered excerpt of a human conversation. Names are whatever the trigger can resolve. */
export interface ConversationSample {
  thread: { who: string; text: string }[];
  latest: { who: string; text: string };
}
export interface DeliveryStatus {
  operationId: string;
  state: "queued" | "waiting" | "delivering" | "delivered" | "failed";
  attempts: number;
  due: number;
  failure: { code: string; attempts: number } | null;
}
export interface TriggerModule {
  create(dependencies: TriggerDependencies): Hono<TriggerAppEnv>;
  deliver?: DeliveryHandler;
}
