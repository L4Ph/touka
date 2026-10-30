import { WorkerEntrypoint } from "cloudflare:workers";
import { createGitHubAppAuth } from "@remote-agent/connector-github";
import type { Env } from "../env";

import { decide, type EgressProps } from "./policy";

export type { EgressProps };

const GITHUB_HOSTS = new Set(["api.github.com", "github.com", "codeload.github.com"]);
let auth: ReturnType<typeof createGitHubAppAuth> | undefined;

/** Outbound handler of every sandbox container: the only place a GitHub credential exists. */
export class GitHubEgress extends WorkerEntrypoint<Env, EgressProps> {
  async fetch(request: Request): Promise<Response> {
    if (!GITHUB_HOSTS.has(new URL(request.url).hostname)) return fetch(request);
    const decision = decide(request, this.ctx.props);
    if (decision.kind === "deny") return new Response(decision.reason, { status: 403 });
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    if (decision.kind === "token") {
      auth ??= createGitHubAppAuth(this.env);
      let token: string;
      try {
        token = await auth.token(decision.repo, decision.access);
      } catch (error) {
        // The container only learns that GitHub refused, not why: the cause may name the App's setup.
        return new Response(error instanceof Error ? error.message : "github_auth_failed", {
          status: 403,
        });
      }
      headers.set(
        "authorization",
        decision.scheme === "Bearer"
          ? `Bearer ${token}`
          : `Basic ${btoa(`x-access-token:${token}`)}`,
      );
    }
    return fetch(new Request(request, { headers }));
  }
}
