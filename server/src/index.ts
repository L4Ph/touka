import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "./env";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { LIMITS, validId, isModelSelection } from "@remote-agent/adapter-contract";
import type { AppEnv } from "./env";
import { teamAuth, sessionAccess, knownSessionIds } from "./auth";
import { mountAdapters } from "./plugins";
import { modelCatalog } from "./models";
export { SessionDirectory } from "./directory";
export { SessionAgent } from "./session";
export { AdapterJobs } from "./jobs";
export { SandboxSession } from "./tools/sandbox/worker";

const app = new Hono<AppEnv>();
app.onError((error, c) => {
  if (["execution_forbidden", "execution_grant_conflict"].includes(error.message))
    return c.json({ error: { code: error.message } }, 403);
  if (["delivery_conflict", "delivery_identity_conflict"].includes(error.message))
    return c.json({ error: { code: error.message } }, 409);
  if (error.message === "delivery_queue_full")
    return c.json({ error: { code: error.message } }, 429);
  if (error.message === "invalid_adapter_execution")
    return c.json({ error: { code: error.message } }, 400);
  if (["invalid_provider_config", "invalid_provider_secret"].includes(error.message))
    return c.json({ error: { code: "model_unconfigured" } }, 503);
  if (error.message === "delivery_unconfigured")
    return c.json({ error: { code: error.message } }, 503);
  return c.json({ error: { code: "internal_error" } }, 500);
});
app.notFound((c) => c.json({ error: { code: "not_found" } }, 404));
app.use(
  "*",
  bodyLimit({
    maxSize: LIMITS.requestBytes,
    onError: (c) => c.json({ error: { code: "payload_too_large" } }, 413),
  }),
);
app.get("/health", (c) => c.json({ status: "ok", service: "remote-agent" }));
app.use("/api/*", teamAuth);
const control = new Hono<AppEnv>();
control.use("/api/sessions/:sessionId", sessionAccess);
control.use("/api/sessions/:sessionId/*", sessionAccess);
const routes = control
  .get("/api/sessions/:sessionId/events", (c) => {
    const id = c.req.param("sessionId");
    const agent = c.env.SESSIONS.getByName(id);
    if (!c.get("teamViewer")) return agent.fetch(c.req.raw);
    const internal = new URL(c.req.url);
    internal.pathname = `/internal/web/${id}`;
    return agent.fetch(new Request(internal, c.req.raw));
  })
  .get("/api/models", async (c) => c.json({ providers: await modelCatalog(c.env) }))
  .get("/api/sessions", async (c) => {
    if (c.get("teamViewer")) {
      const directory = c.env.SESSION_DIRECTORY?.getByName("team");
      if (!directory) return c.json({ error: { code: "directory_unconfigured" } }, 503);
      // Legacy discovery requires known IDs, never DO enumeration or a wildcard grant.
      const seeds: unknown = JSON.parse(c.env.SESSION_INDEX_SEEDS ?? "[]");
      if (!Array.isArray(seeds) || seeds.length > 1000 || !seeds.every(validId))
        return c.json({ error: { code: "directory_unconfigured" } }, 503);
      const known = [...new Set([...seeds, ...knownSessionIds(c.env.TEAM_AUTH)])];
      if (known.length > 1000) return c.json({ error: { code: "directory_unconfigured" } }, 503);
      for (const id of known) await directory.register(id);
      const after = c.req.query("after") ?? "";
      const limit = Number(c.req.query("limit") ?? "50");
      if ((after && !validId(after)) || !Number.isInteger(limit) || limit < 1 || limit > 100)
        return c.json({ error: { code: "invalid_page" } }, 400);
      const page = await directory.page(after, limit);
      const sessions = await Promise.all(
        page.ids.map(async (sessionId) => {
          const summary = await c.env.SESSIONS.getByName(sessionId).summary();
          return summary ? { sessionId, ...summary } : null;
        }),
      );
      return c.json({ sessions: sessions.filter((item) => item !== null), next: page.next });
    }
    const sessions = await Promise.all(
      c.get("principal").sessions.map(async (sessionId) => {
        const summary = await c.env.SESSIONS.getByName(sessionId).summary();
        return summary ? { sessionId, ...summary } : null;
      }),
    );
    return c.json({ sessions: sessions.filter((session) => session !== null) });
  })
  .post("/api/sessions", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      !validId(body.sessionId) ||
      Object.keys(body).some((key) => !["sessionId", "model"].includes(key)) ||
      (body.model !== undefined && !isModelSelection(body.model))
    )
      return c.json({ error: { code: "invalid_session_config" } }, 400);
    if (!c.get("teamViewer") && !c.get("principal").sessions.includes(body.sessionId))
      return c.json({ error: { code: "forbidden" } }, 403);
    const result = await c.env.SESSIONS.getByName(body.sessionId).create(
      body.model,
      body.sessionId,
    );
    if (result.error)
      return c.json(
        { error: { code: result.error } },
        result.error === "session_exists" ? 409 : result.error === "model_unconfigured" ? 503 : 400,
      );
    return c.json({ sessionId: body.sessionId }, 201);
  })
  .post("/api/sessions/:sessionId/inputs", async (c) => {
    if (!c.get("teamViewer")) return c.json({ error: { code: "forbidden" } }, 403);
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      !validId(body.operationId) ||
      typeof body.input !== "string" ||
      !body.input.trim() ||
      new TextEncoder().encode(body.input).length > 16000 ||
      Object.keys(body).some((key) => !["operationId", "input"].includes(key))
    )
      return c.json({ error: { code: "invalid_input" } }, 400);
    const agent = c.env.SESSIONS.getByName(c.req.param("sessionId"));
    if (!(await agent.summary())) return c.json({ error: { code: "session_not_found" } }, 404);
    const receipt = await agent.submitShared({ sessionId: c.req.param("sessionId"), ...body });
    return receipt ? c.json(receipt, 202) : c.json({ error: { code: "queue_full" } }, 429);
  })
  .get("/api/sessions/:sessionId", async (c) => {
    const result = await c.env.SESSIONS.getByName(c.req.param("sessionId")).summary();
    if (!result) return c.json({ error: { code: "session_not_found" } }, 404);
    return c.json({ sessionId: c.req.param("sessionId"), ...result });
  })
  .get("/api/sessions/:sessionId/messages", async (c) => {
    return c.body(await c.env.SESSIONS.getByName(c.req.param("sessionId")).transcript(), 200, {
      "Content-Type": "application/json",
    });
  })
  .put("/api/sessions/:sessionId/model", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!isModelSelection(body)) return c.json({ error: { code: "invalid_model" } }, 400);
    const agent = c.env.SESSIONS.getByName(c.req.param("sessionId"));
    if (!(await agent.summary())) return c.json({ error: { code: "session_not_found" } }, 404);
    const result = await agent.setModel(body);
    if (result.error)
      return c.json(
        { error: { code: result.error } },
        result.error === "model_unconfigured" ? 503 : 400,
      );
    return c.json({ model: body });
  })
  .post("/api/sessions/:sessionId/abort", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "operationId") ||
      (body.operationId !== undefined && !validId(body.operationId))
    )
      return c.json({ error: { code: "invalid_operation" } }, 400);
    return c.json({
      aborted: await c.env.SESSIONS.getByName(c.req.param("sessionId")).abort(body.operationId),
    });
  })
  .post("/api/sessions/:sessionId/retry", async (c) => {
    return c.json({ retried: await c.env.SESSIONS.getByName(c.req.param("sessionId")).retry() });
  })
  .get("/api/sessions/:sessionId/runtime", async (c) => {
    const result = await c.env.SESSIONS.getByName(c.req.param("sessionId")).inspect();
    return c.json(result);
  })
  .get("/api/sessions/:sessionId/operations/:operationId", async (c) => {
    const { sessionId, operationId } = c.req.param();
    if (!validId(operationId)) return c.json({ error: { code: "invalid_operation" } }, 400);
    const result = await c.env.SESSIONS.getByName(sessionId).operation(sessionId, operationId);
    if (!result) return c.json({ error: { code: "operation_not_found" } }, 404);
    return c.json(result);
  });
app.route("/", control);
mountAdapters(app);

// Named entrypoints are service-binding-only, not publicly routed Worker URLs.
export class WebGateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    const web = new Hono<AppEnv>();
    web.onError((_error, c) => c.json({ error: { code: "request_failed" } }, 500));
    web.use("*", bodyLimit({ maxSize: LIMITS.requestBytes }));
    web.use("*", async (c, next) => {
      const identity = c.req.header("x-team-user");
      if (!identity || identity.length > 256)
        return c.json({ error: { code: "unauthorized" } }, 401);
      if (!c.env.SESSION_DIRECTORY)
        return c.json({ error: { code: "directory_unconfigured" } }, 503);
      c.set("teamViewer", true);
      c.set("principal", { id: "team-web", sessions: [], resources: [] });
      c.header("Cache-Control", "no-store");
      await next();
    });
    web.route("/", control);
    return web.fetch(request, this.env);
  }
}
export type ControlApi = typeof routes;
export default app;
