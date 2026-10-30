import type nodeAssert from "node:assert/strict";
import { validId, type Principal } from "@remote-agent/agent-contract";

// Only trusted, authenticated triggers/control routes may construct this server-side grant.
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

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;

  const token = "delivery-runtime-token-not-secret-00001";
  const sessions = ["tools"];
  const member = { id: "member", token, sessions, resources: ["github:team/project:read"] };

  test("execution grants reject missing session/resource authority and canonicalize only authenticated grants", () => {
    assert.throws(() => executionGrant("tools", undefined), /execution_forbidden/);
    assert.throws(() => executionGrant("private", member), /execution_forbidden/);
    assert.throws(
      () => executionGrant("tools", { ...member, resources: ["x".repeat(257)] }),
      /execution_forbidden/,
    );
    assert.deepEqual(executionGrant("tools", { ...member, resources: ["b", "a", "b"] }), {
      sessionId: "tools",
      principal: { id: "member", sessions: ["tools"], resources: ["a", "b"] },
    });
  });
}
