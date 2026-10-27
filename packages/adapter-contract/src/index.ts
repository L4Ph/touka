import type { Hono, MiddlewareHandler } from "hono";
import type { Principal, SubmitInput, SubmitReceipt, OperationStatus } from "./core";
export * from "./core";

export interface AdapterExecution {
  adapter: string;
  input: SubmitInput;
  principal: Principal;
  /** Adapter-owned destination/audit data. Never passed to Pi. */
  reply: Record<string, unknown>;
}
export interface AdapterEnv {
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
export type AdapterAppEnv = { Bindings: AdapterEnv; Variables: { principal: Principal } };
export interface GitHubAuth {
  installation(repo: string): number;
  token(repo: string, access?: "read" | "write" | "reply"): Promise<string>;
  invalidate(repo: string, access?: "read" | "write" | "reply"): void;
}
export interface DeliveryContext {
  env: AdapterEnv;
  job: AdapterExecution;
  result: OperationStatus;
  signal: AbortSignal;
  github: GitHubAuth;
}
export type DeliveryResult =
  | { status: "delivered" }
  | { status: "retry" | "failed"; code: string; retryAfterMs?: number };
export type DeliveryHandler = (context: DeliveryContext) => Promise<DeliveryResult>;
export interface AdapterDependencies {
  authenticate: MiddlewareHandler<AdapterAppEnv>;
  submit(env: AdapterEnv, input: SubmitInput, principal: Principal): Promise<SubmitReceipt | null>;
  execute(
    env: AdapterEnv,
    request: AdapterExecution,
  ): Promise<{ accepted: boolean; operationId: string }>;
  status(
    env: AdapterEnv,
    adapter: string,
    sessionId: string,
    operationId: string,
  ): Promise<DeliveryStatus | null>;
  github(env: AdapterEnv): GitHubAuth;
}
export interface DeliveryStatus {
  operationId: string;
  state: "queued" | "waiting" | "delivering" | "delivered" | "failed";
  attempts: number;
  due: number;
  failure: { code: string; attempts: number } | null;
}
export interface AdapterModule {
  create(dependencies: AdapterDependencies): Hono<AdapterAppEnv>;
  deliver?: DeliveryHandler;
}
