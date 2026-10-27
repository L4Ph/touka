import { validId, type Principal } from "@remote-agent/adapter-contract";

// Only trusted, authenticated adapters/control routes may construct this server-side grant.
export function executionGrant(sessionId: string, principal: Principal | undefined) {
  if (
    !validId(sessionId) ||
    !principal ||
    !validId(principal.id) ||
    !Array.isArray(principal.sessions) ||
    !principal.sessions.includes(sessionId) ||
    !Array.isArray(principal.resources) ||
    principal.resources.length > 100 ||
    !principal.resources.every((resource) => typeof resource === "string" && resource.length <= 256)
  ) {
    throw new Error("execution_forbidden");
  }
  return {
    sessionId,
    principal: {
      id: principal.id,
      sessions: [sessionId],
      resources: [...new Set(principal.resources)].sort(),
    },
  };
}
