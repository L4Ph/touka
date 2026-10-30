import { Hono } from "hono";
import type { PiHarness } from "agents/harness/pi";
import type { DurableObjectCapability } from "agents/lifecycle";
import { teamAuth, sessionAccess } from "./auth";
import type { AppEnv, Env } from "./env";
import { STREAM_LIMITS, type SessionStreamFrame } from "./stream-protocol";
import { encodeStreamFrame } from "./stream-frame";

type Events = Awaited<ReturnType<ReturnType<PiHarness["session"]>["events"]>>;

/** One socket's live subscription. It is memory only: a hibernated socket gets a new one on wake. */
interface Subscription {
  stream: Events;
  sequence: number;
  queuedBytes: number;
  unacked: Map<number, number>;
}

const OWNER = "touka.stream";
const owned = (ws: WebSocket) =>
  (ws.deserializeAttachment() as { owner?: string } | null)?.owner === OWNER;

/**
 * The read-only event stream of a session, as a Lifecycle capability. Sockets are hibernatable: the
 * platform keeps them while the object is evicted, and a wake re-subscribes each one, which sends a
 * fresh snapshot frame (clients already reconnect from a snapshot).
 */
export class SessionStream implements DurableObjectCapability {
  private readonly subscriptions = new Map<WebSocket, Subscription>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
    private readonly harness: PiHarness,
    private readonly exists: () => Promise<boolean>,
  ) {}

  async onStart() {
    for (const ws of this.ctx.getWebSockets()) if (owned(ws)) await this.subscribe(ws);
  }

  /** Every request the Worker forwards here is checked again; this object is not reachable otherwise. */
  onRequest({ request }: { request: Request }) {
    return this.route(request);
  }

  onWebSocketUpgrade({ request }: { request: Request }) {
    return this.route(request);
  }

  private async route(request: Request): Promise<Response | undefined> {
    const app = new Hono<AppEnv>();
    app.use("*", teamAuth);
    app.use("/api/sessions/:sessionId/events", sessionAccess);
    app.get("/api/sessions/:sessionId/events", async (c) => {
      if (!this.ctx.id.equals(this.env.PI_DURABLE.idFromName(c.req.param("sessionId"))))
        return c.json({ error: { code: "forbidden" } }, 403);
      if (new URL(request.url).search) return c.json({ error: { code: "query_not_allowed" } }, 400);
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return c.json({ error: { code: "upgrade_required" } }, 426);
      if (!(await this.exists())) return c.json({ error: { code: "session_not_found" } }, 404);
      if (this.ctx.getWebSockets().length >= STREAM_LIMITS.connections)
        return c.json({ error: { code: "connection_limit" } }, 429);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ owner: OWNER });
      try {
        await this.subscribe(server);
      } catch (error) {
        server.close(1011, "Stream unavailable");
        throw error;
      }
      return new Response(null, { status: 101, webSocket: client });
    });
    const url = new URL(request.url);
    // Anything else on this object is not ours: decline so the host answers it.
    if (!/^\/api\/sessions\/[^/]+\/events$/.test(url.pathname)) return undefined;
    return app.fetch(request, this.env);
  }

  private async subscribe(ws: WebSocket): Promise<void> {
    const stream = await this.harness.session().events();
    const sub: Subscription = { stream, sequence: 0, queuedBytes: 0, unacked: new Map() };
    this.subscriptions.set(ws, sub);
    this.send(ws, sub, { type: "snapshot", sequence: sub.sequence++, snapshot: stream.snapshot });
    if (this.subscriptions.get(ws) === sub)
      stream.start(async (events) => {
        this.send(ws, sub, { type: "events", sequence: sub.sequence++, events });
      });
    void stream.closed.then(() => {
      if (this.subscriptions.get(ws) === sub) this.close(ws, 1011, "Stream ended; reconnect");
    });
  }

  private send(ws: WebSocket, sub: Subscription, frame: SessionStreamFrame) {
    if (this.subscriptions.get(ws) !== sub) return;
    const encoded = encodeStreamFrame(frame);
    if (!encoded) return this.close(ws, 1009, "Frame too large; use HTTP history");
    const { data, bytes } = encoded;
    if (
      sub.unacked.size >= STREAM_LIMITS.unackedFrames ||
      sub.queuedBytes + bytes > STREAM_LIMITS.unackedBytes
    )
      return this.close(ws, 1008, "Slow consumer; reconnect");
    sub.unacked.set(frame.sequence, bytes);
    sub.queuedBytes += bytes;
    try {
      ws.send(data);
    } catch {
      this.release(ws);
    }
  }

  private release(ws: WebSocket) {
    const sub = this.subscriptions.get(ws);
    if (!sub) return;
    this.subscriptions.delete(ws);
    sub.unacked.clear();
    void sub.stream.stop();
  }

  private close(ws: WebSocket, code: number, reason: string) {
    this.release(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  async onWebSocketMessage(ws: WebSocket, data: string | ArrayBuffer | ArrayBufferView) {
    if (!owned(ws)) return false;
    // A message that wakes a hibernated object can arrive before its subscription is rebuilt.
    const sub = this.subscriptions.get(ws);
    if (!sub) return true;
    if (
      typeof data !== "string" ||
      new TextEncoder().encode(data).byteLength > STREAM_LIMITS.clientBytes
    ) {
      this.close(ws, 1009, "Client message too large");
      return true;
    }
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.close(ws, 1008, "Invalid message");
      return true;
    }
    if (message?.type === "unsubscribe" && Object.keys(message).length === 1) {
      this.close(ws, 1000, "Unsubscribed");
      return true;
    }
    if (
      message?.type !== "ack" ||
      Object.keys(message).length !== 2 ||
      !Number.isSafeInteger(message.sequence) ||
      !sub.unacked.has(message.sequence)
    ) {
      this.close(ws, 1008, "Read-only stream");
      return true;
    }
    for (const [id, bytes] of sub.unacked) {
      if (id <= message.sequence) {
        sub.unacked.delete(id);
        sub.queuedBytes -= bytes;
      }
    }
    return true;
  }

  onWebSocketClose(ws: WebSocket) {
    if (!owned(ws)) return false;
    this.close(ws, 1000, "Closed");
    return true;
  }

  onWebSocketError(ws: WebSocket) {
    if (!owned(ws)) return false;
    this.release(ws);
    return true;
  }
}
