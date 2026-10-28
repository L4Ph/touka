import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { LIMITS, validId, isModelSelection } from "@remote-agent/agent-contract";
import type { AppEnv } from "./env";
import { teamAuth, sessionAccess } from "./auth";
import { mountTriggers } from "./plugins";
import { modelCatalog } from "./models";
export { SessionAgent } from "./session";
export { TriggerJobs } from "./jobs";
export { SandboxSession } from "./tools/sandbox/worker";

const app = new Hono<AppEnv>();
app.onError((error, c) => {
  if (["execution_forbidden", "execution_grant_conflict"].includes(error.message))
    return c.json({ error: { code: error.message } }, 403);
  if (["delivery_conflict", "delivery_identity_conflict"].includes(error.message))
    return c.json({ error: { code: error.message } }, 409);
  if (error.message === "delivery_queue_full")
    return c.json({ error: { code: error.message } }, 429);
  if (error.message === "invalid_trigger_execution")
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
app.use("/api/sessions/:sessionId", sessionAccess);
app.use("/api/sessions/:sessionId/*", sessionAccess);
app
  .get("/api/sessions/:sessionId/events", (c) =>
    c.env.SESSIONS.getByName(c.req.param("sessionId")).fetch(c.req.raw),
  )
  .get("/api/models", async (c) => c.json({ providers: await modelCatalog(c.env) }))
  .get("/api/sessions", async (c) => {
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
    if (!c.get("principal").sessions.includes(body.sessionId))
      return c.json({ error: { code: "forbidden" } }, 403);
    const result = await c.env.SESSIONS.getByName(body.sessionId).create(body.model);
    if (result.error)
      return c.json(
        { error: { code: result.error } },
        result.error === "session_exists" ? 409 : result.error === "model_unconfigured" ? 503 : 400,
      );
    return c.json({ sessionId: body.sessionId }, 201);
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
  .post("/api/sessions/:sessionId/retry", async (c) =>
    c.json({ retried: await c.env.SESSIONS.getByName(c.req.param("sessionId")).retry() }),
  )
  .get("/api/sessions/:sessionId/runtime", async (c) =>
    c.json(await c.env.SESSIONS.getByName(c.req.param("sessionId")).inspect()),
  )
  .get("/api/sessions/:sessionId/operations/:operationId", async (c) => {
    const { sessionId, operationId } = c.req.param();
    if (!validId(operationId)) return c.json({ error: { code: "invalid_operation" } }, 400);
    const result = await c.env.SESSIONS.getByName(sessionId).operation(sessionId, operationId);
    if (!result) return c.json({ error: { code: "operation_not_found" } }, 404);
    return c.json(result);
  });
mountTriggers(app);
export default app;
