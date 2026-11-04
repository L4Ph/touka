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

/** A server policy update can apply to a new run, never to an active/queued run or another owner. */
export function assertGrantChange(
  previous: { sessionId: string; principal: Principal } | undefined,
  next: { sessionId: string; principal: Principal },
  busy: boolean,
): void {
  if (
    busy ||
    (previous &&
      (previous.sessionId !== next.sessionId || previous.principal.id !== next.principal.id))
  )
    throw new Error("execution_grant_conflict");
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;

  const token = "delivery-runtime-token-not-secret-00001";
  const sessions = ["tools"];
  const member = { id: "member", token, sessions, resources: ["github:team/project:read"] };

  test("policy changes apply only between runs for the same session owner", () => {
    const previous = executionGrant("tools", member);
    const next = executionGrant("tools", {
      ...member,
      resources: [...member.resources, "github:team/project:workflow"],
    });
    assert.doesNotThrow(() => assertGrantChange(previous, next, false));
    assert.throws(() => assertGrantChange(previous, next, true), /execution_grant_conflict/);
    assert.throws(() => assertGrantChange(undefined, next, true), /execution_grant_conflict/);
    assert.throws(
      () => assertGrantChange(previous, executionGrant("tools", { ...member, id: "other" }), false),
      /execution_grant_conflict/,
    );
  });

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
