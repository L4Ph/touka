import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { RemoteExecutionEnv } from "@earendil-works/pi-env";
import type { Principal } from "@remote-agent/agent-contract";
import type { Env } from "../env";
import { asConnection, ContainerConnection } from "./connection";
import { TRUST_ENV } from "./image";

export interface SandboxContext {
  env: Env;
  principal: Principal;
  sessionId: string;
}

/** The caller must be authorized for the session and hold `sandbox:<session>:execute` (or `*`). */
export function permit({ principal, sessionId }: Pick<SandboxContext, "principal" | "sessionId">) {
  if (
    !principal.sessions.includes(sessionId) ||
    !["*", sessionId].some((target) => principal.resources.includes(`sandbox:${target}:execute`))
  )
    throw new Error("sandbox_forbidden");
}

/**
 * Pi's own `read`, `write`, `edit` and `bash` run against this environment: the session's container,
 * reached through the pi-env daemon. The model cannot choose another session's container.
 */
export function sandbox(context: SandboxContext): { env: () => ExecutionEnv; close: () => void } {
  let connection: ContainerConnection | undefined;
  const open = () => {
    permit(context);
    const namespace = context.env.SANDBOX_CONTAINER;
    if (!namespace) throw new Error("sandbox_unconfigured");
    return (connection ??= new ContainerConnection(async (token) => {
      // The container's own GitHub traffic is limited to what this principal may reach.
      const resources = context.principal.resources.filter((resource) =>
        resource.startsWith("github:"),
      );
      const hash = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(context.sessionId),
      );
      const name =
        "sandbox-" +
        Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
      return namespace.getByName(name).daemon(token, { resources });
    }));
  };
  return {
    env: () =>
      new RemoteExecutionEnv({
        connection: asConnection(open()),
        id: `sandbox:${context.sessionId}`,
        cwd: "/workspace",
        shellEnv: { ...TRUST_ENV },
      }),
    close: () => connection?.close(),
  };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const principal = (resources: string[], sessions = ["s"]): Principal => ({
    id: "p",
    sessions,
    resources,
  });

  test("a session's container needs its own execute grant, or the wildcard", () => {
    expect(() =>
      permit({ principal: principal(["sandbox:s:execute"]), sessionId: "s" }),
    ).not.toThrow();
    expect(() =>
      permit({ principal: principal(["sandbox:*:execute"]), sessionId: "s" }),
    ).not.toThrow();
    expect(() =>
      permit({ principal: principal(["sandbox:other:execute"]), sessionId: "s" }),
    ).toThrow("sandbox_forbidden");
    expect(() => permit({ principal: principal(["sandbox:s:read"]), sessionId: "s" })).toThrow(
      "sandbox_forbidden",
    );
    expect(() =>
      permit({ principal: principal(["sandbox:s:execute"], ["x"]), sessionId: "s" }),
    ).toThrow("sandbox_forbidden");
  });
}
