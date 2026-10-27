import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./env";
import { validId, type Principal, type AdapterAppEnv } from "@remote-agent/adapter-contract";

type Member = Principal & { token: string };
function members(raw: string | undefined): Member[] {
  if (!raw) throw new Error("auth_unconfigured");
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.length === 0 || data.length > 100)
    throw new Error("auth_unconfigured");
  const tokens = new Set<string>();
  for (const member of data) {
    if (
      !member ||
      !validId(member.id) ||
      typeof member.token !== "string" ||
      member.token.length < 32 ||
      !Array.isArray(member.sessions) ||
      !member.sessions.every(validId) ||
      !Array.isArray(member.resources) ||
      !member.resources.every((s: unknown) => typeof s === "string" && s.length <= 256) ||
      tokens.has(member.token)
    )
      throw new Error("auth_unconfigured");
    tokens.add(member.token);
  }
  return data;
}
async function equal(a: string, b: string): Promise<boolean> {
  const digest = (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [left, right] = await Promise.all([digest(a), digest(b)]);
  return timingSafeEqual(new Uint8Array(left), new Uint8Array(right));
}
export const teamAuth: MiddlewareHandler<AdapterAppEnv> = async (c, next) => {
  let configured: Member[];
  try {
    configured = members(c.env.TEAM_AUTH);
  } catch {
    return c.json({ error: { code: "auth_unconfigured" } }, 503);
  }
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ") || header.length > 1024)
    return c.json({ error: { code: "unauthorized" } }, 401);
  let principal: Principal | undefined;
  for (const member of configured) {
    if (await equal(header.slice(7), member.token))
      principal = { id: member.id, sessions: member.sessions, resources: member.resources };
  }
  if (!principal) return c.json({ error: { code: "unauthorized" } }, 401);
  c.set("principal", principal);
  await next();
};
export const sessionAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  const id = c.req.param("sessionId");
  if (!validId(id)) return c.json({ error: { code: "invalid_session" } }, 400);
  if (!c.get("principal").sessions.includes(id))
    return c.json({ error: { code: "forbidden" } }, 403);
  await next();
};
