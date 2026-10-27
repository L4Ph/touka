import { Hono } from 'hono';
import type { PiHarness } from 'agents/harness/pi';
import { teamAuth, sessionAccess } from './auth';
import type { AppEnv, Env } from './env';
import { STREAM_LIMITS, type SessionStreamFrame } from '../../shared/stream';

export function sessionStream(request: Request, env: Env, ctx: DurableObjectState, harness: PiHarness, connections: Set<WebSocket>, exists: () => Promise<boolean>) {
  const app = new Hono<AppEnv>();
  app.use('*', teamAuth);
  app.use('/api/sessions/:sessionId/events', sessionAccess);
  app.get('/api/sessions/:sessionId/events', async (c) => {
    if (!ctx.id.equals(env.SESSIONS.idFromName(c.req.param('sessionId')))) return c.json({ error: { code: 'forbidden' } }, 403);
    if (new URL(request.url).search) return c.json({ error: { code: 'query_not_allowed' } }, 400);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return c.json({ error: { code: 'upgrade_required' } }, 426);
    if (!await exists()) return c.json({ error: { code: 'session_not_found' } }, 404);
    if (connections.size >= STREAM_LIMITS.connections) return c.json({ error: { code: 'connection_limit' } }, 429);
    const [client, socket] = Object.values(new WebSocketPair());
    connections.add(socket);
    let stream: Awaited<ReturnType<ReturnType<PiHarness['session']>['events']>>;
    try { stream = await harness.session().events(); }
    catch (error) { connections.delete(socket); throw error; }
    let closed = false;
    let sequence = 0;
    let queuedBytes = 0;
    const unacked = new Map<number, number>();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      connections.delete(socket);
      unacked.clear();
      void stream.stop();
    };
    const close = (code: number, reason: string) => {
      cleanup();
      socket.close(code, reason);
    };
    const send = (frame: SessionStreamFrame) => {
      if (closed) return;
      const data = JSON.stringify(frame);
      const bytes = new TextEncoder().encode(data).byteLength;
      if (bytes > STREAM_LIMITS.frameBytes) return close(1009, 'Frame too large; use HTTP history');
      if (unacked.size >= STREAM_LIMITS.unackedFrames || queuedBytes + bytes > STREAM_LIMITS.unackedBytes) return close(1008, 'Slow consumer; reconnect');
      unacked.set(frame.sequence, bytes);
      queuedBytes += bytes;
      try { socket.send(data); } catch { cleanup(); }
    };
    socket.accept();
    socket.addEventListener('close', () => { cleanup(); socket.close(); });
    socket.addEventListener('error', cleanup);
    socket.addEventListener('message', ({ data }) => {
      if (closed) return;
      if (typeof data !== 'string' || new TextEncoder().encode(data).byteLength > STREAM_LIMITS.clientBytes) return close(1009, 'Client message too large');
      let message;
      try { message = JSON.parse(data); } catch { return close(1008, 'Invalid message'); }
      if (message?.type === 'unsubscribe' && Object.keys(message).length === 1) return close(1000, 'Unsubscribed');
      if (message?.type !== 'ack' || Object.keys(message).length !== 2 || !Number.isSafeInteger(message.sequence) || !unacked.has(message.sequence)) return close(1008, 'Read-only stream');
      for (const [id, bytes] of unacked) {
        if (id <= message.sequence) { unacked.delete(id); queuedBytes -= bytes; }
      }
    });
    send({ type: 'snapshot', sequence: sequence++, snapshot: stream.snapshot });
    if (!closed) stream.start(async (events) => { send({ type: 'events', sequence: sequence++, events }); });
    void stream.closed.then(() => { if (!closed) close(1011, 'Stream ended; reconnect'); });
    return new Response(null, { status: 101, webSocket: client });
  });
  return app.fetch(request, env);
}
