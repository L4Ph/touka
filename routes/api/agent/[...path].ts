import { defineHandler } from "void";
import { getSession } from "void/auth";
import { STREAM_LIMITS } from "../../../shared/stream";
import { allowedTeamEmail } from "../../../shared/team-policy";

const proxy = defineHandler(async (c) => {
  c.header("Cache-Control", "no-store");
  const state = getSession();
  if (!state) return c.json({ error: { code: "unauthorized" } }, 401);
  if (!state.user.emailVerified || !allowedTeamEmail(c.env.TEAM_EMAILS, state.user.email))
    return c.json({ error: { code: "forbidden" } }, 403);
  const url = new URL(c.req.url);
  const websocket = c.req.header("upgrade")?.toLowerCase() === "websocket";
  const origin = c.req.header("origin");
  // Even same-site sibling origins are not trusted, including for read-only sockets.
  if (
    (origin && origin !== url.origin) ||
    ((websocket || !["GET", "HEAD"].includes(c.req.method)) && origin !== url.origin)
  )
    return c.json({ error: { code: "untrusted_origin" } }, 403);
  if (!c.env.AGENT_CORE) return c.json({ error: { code: "core_unconfigured" } }, 503);
  const path = url.pathname.slice("/api/agent".length);
  if (!/^\/(sessions(?:\/|$)|models$)/.test(path))
    return c.json({ error: { code: "not_found" } }, 404);
  url.pathname = `/api${path}`;
  const headers = new Headers({ "x-team-user": state.user.id });
  if (c.req.header("content-type")) headers.set("content-type", c.req.header("content-type")!);
  if (websocket) headers.set("upgrade", "websocket");
  const response = await c.env.AGENT_CORE.fetch(
    new Request(url, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? undefined : c.req.raw.body,
      redirect: "manual",
    }),
  );
  if (!response.webSocket) {
    const output = new Response(response.body, response);
    output.headers.set("Cache-Control", "no-store");
    return output;
  }
  // The proxy owns browser sockets so logout/DB revocation closes existing streams too.
  const upstream = response.webSocket;
  const [client, socket] = Object.values(new WebSocketPair());
  upstream.accept();
  socket.accept();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    socket.close(1008, "Session ended; reconnect");
    upstream.close(1000, "Session ended");
  };
  const valid = async () => {
    const record = await c.env.DB.prepare(
      "SELECT user.email, user.emailVerified FROM session JOIN user ON user.id = session.userId WHERE session.id = ? AND session.userId = ? AND session.expiresAt > ?",
    )
      .bind(state.session.id, state.user.id, Date.now())
      .first();
    if (
      !record ||
      !record.emailVerified ||
      typeof record.email !== "string" ||
      !allowedTeamEmail(c.env.TEAM_EMAILS, record.email) ||
      Date.now() >= new Date(state.session.expiresAt).getTime()
    )
      close();
    return !closed;
  };
  const timer = setInterval(() => {
    void valid().catch(close);
  }, 5000);
  let delivery = Promise.resolve();
  let queuedBytes = 0;
  upstream.addEventListener("message", ({ data }) => {
    if (typeof data !== "string") return close();
    const bytes = new TextEncoder().encode(data).byteLength;
    queuedBytes += bytes;
    if (queuedBytes > STREAM_LIMITS.unackedBytes) return close();
    delivery = delivery
      .then(async () => {
        if (await valid()) socket.send(data);
        queuedBytes -= bytes;
      })
      .catch(close);
  });
  socket.addEventListener("message", ({ data }) => {
    if (!closed) upstream.send(data);
  });
  for (const connection of [socket, upstream]) {
    connection.addEventListener("close", close);
    connection.addEventListener("error", close);
  }
  return new Response(null, { status: 101, webSocket: client });
});

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
