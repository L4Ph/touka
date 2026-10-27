import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globSync } from 'node:fs';
import { Miniflare, Response as WorkerResponse, fetch as upgrade, type WebSocket } from 'miniflare';
import type { SessionStreamFrame } from '../../shared/stream';

const token = 'stream-local-token-not-a-secret-000001';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const sonnet = { provider: 'anthropic', id: 'claude-sonnet-4-5' };
const opus = { provider: 'anthropic', id: 'claude-opus-4-5' };
const worker = {
  modules: ['dist/remote_agent_server/index.js', ...globSync('dist/remote_agent_server/assets/*.js')]
    .map((path) => ({ type: 'ESModule' as const, path })),
  compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { SESSIONS: { className: 'SessionAgent', useSQLite: true } },
};

function providerEvent(event: { type: string; [key: string]: unknown }) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const providerStart = providerEvent({ type: 'message_start', message: {
  id: 'msg_local', type: 'message', role: 'assistant', model: sonnet.id, content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 },
} }) + providerEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
const providerDelta = (text: string) => providerEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const providerEnd = providerEvent({ type: 'content_block_stop', index: 0 })
  + providerEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
  + providerEvent({ type: 'message_stop' });

function reader(socket: WebSocket, ack = true) {
  const frames: SessionStreamFrame[] = [];
  let wake: (() => void) | undefined;
  socket.addEventListener('message', ({ data }) => {
    assert.equal(typeof data, 'string');
    const frame = JSON.parse(String(data)) as SessionStreamFrame;
    frames.push(frame);
    if (ack) socket.send(JSON.stringify({ type: 'ack', sequence: frame.sequence }));
    wake?.();
  });
  const closed = new Promise<number>((resolve) => socket.addEventListener('close', (event) => resolve(event.code)));
  socket.accept();
  return {
    closed,
    async next() {
      const signal = AbortSignal.timeout(5000);
      while (!frames.length) {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return frames.shift()!;
    },
  };
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Connection slot was not released');
}

test('real HTTP upgrades fail closed for absent credentials, session ACLs and query credentials', { timeout: 20_000, concurrency: true }, async () => {
  const runtime = new Miniflare({ ...worker, bindings: {
    TEAM_AUTH: JSON.stringify([{ id: 'owner', token, sessions: ['one'], resources: [] }]),
  } });
  try {
    const base = await runtime.ready;
    for (const [path, auth, status] of [
      ['/api/sessions/one/events', {}, 401],
      ['/api/sessions/one/events', { Authorization: 'Bearer wrong' }, 401],
      ['/api/sessions/denied/events', headers, 403],
      [`/api/sessions/one/events?token=${token}`, {}, 401],
      [`/api/sessions/one/events?token=${token}`, headers, 400],
      ['/api/sessions/one/events', headers, 404],
    ] as const) {
      const response = await upgrade(new URL(path, base), { headers: { ...auth, Upgrade: 'websocket' } });
      assert.equal(response.status, status, path.split('?')[0]);
      assert.equal(response.webSocket, null);
      await response.text();
    }
    assert.equal((await fetch(new URL('/api/sessions/one/events', base), { headers })).status, 426);
  } finally { await runtime.dispose(); }
  const unconfigured = new Miniflare(worker);
  try {
    const response = await upgrade(new URL('/api/sessions/one/events', await unconfigured.ready), { headers: { ...headers, Upgrade: 'websocket' } });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'auth_unconfigured' } });
  } finally { await unconfigured.dispose(); }
});

test('snapshot precedes committed Pi batches, reconnect refreshes state, clients cannot write, and disconnect releases bounded slots', { timeout: 45_000, concurrency: true }, async () => {
  // No model traffic is needed: setModel commits exercise the actual Pi event stream.
  const runtime = new Miniflare({ ...worker, bindings: {
    TEAM_AUTH: JSON.stringify([{ id: 'owner', token, sessions: ['one', 'two'], resources: [] }]),
    MODEL_PROVIDER: sonnet.provider, MODEL_ID: sonnet.id, ANTHROPIC_API_KEY: 'local-fake-key',
  } });
  const sockets: WebSocket[] = [];
  try {
    const base = await runtime.ready;
    const call = (path: string, method = 'GET', body?: unknown) => fetch(new URL(path, base), {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    for (const sessionId of ['one', 'two']) assert.equal((await call('/api/sessions', 'POST', { sessionId })).status, 201);
    const connect = async (sessionId = 'one', ack = true) => {
      const response = await upgrade(new URL(`/api/sessions/${sessionId}/events`, base), { headers: { ...headers, Upgrade: 'websocket' } });
      assert.equal(response.status, 101);
      const socket = response.webSocket;
      assert(socket);
      sockets.push(socket);
      return { socket, ...reader(socket, ack) };
    };
    const first = await connect();
    const initial = await first.next();
    assert.equal(initial.type, 'snapshot');
    assert.equal(initial.sequence, 0);
    assert(initial.type === 'snapshot');
    assert.deepEqual(initial.snapshot.entries, []);
    assert.equal(initial.snapshot.agent.model?.modelId, sonnet.id);
    assert.equal(JSON.stringify(initial).includes('local-fake-key'), false);
    assert.equal((await call('/api/sessions/one/model', 'PUT', opus)).status, 200);
    const batch = await first.next();
    assert.equal(batch.type, 'events');
    assert.equal(batch.sequence, 1);
    assert(batch.type === 'events');
    assert(batch.events.some((event) => event.type === 'agent_changed' && event.agent.model?.modelId === opus.id));
    const durable = await (await call('/api/sessions/one')).json() as { model: unknown };
    assert.deepEqual(durable.model, opus, 'The streamed change must already be durable');
    const second = await connect('two');
    const isolated = await second.next();
    assert(isolated.type === 'snapshot');
    assert.equal(isolated.snapshot.agent.model?.modelId, sonnet.id, 'Another session must not inherit events');
    for (const [oneModel, twoModel] of [[sonnet, opus], [opus, sonnet]]) {
      assert.equal((await call('/api/sessions/one/model', 'PUT', oneModel)).status, 200);
      assert.equal((await call('/api/sessions/two/model', 'PUT', twoModel)).status, 200);
      for (const [client, model] of [[first, oneModel], [second, twoModel]] as const) {
        const live = await client.next();
        assert(live.type === 'events');
        assert.deepEqual(
          live.events.filter((event) => event.type === 'agent_changed').map((event) => event.agent.model?.modelId),
          [model.id],
          'Each live batch must contain only its own session model change',
        );
      }
    }
    first.socket.send(JSON.stringify({ type: 'unsubscribe' }));
    assert.equal(await first.closed, 1000);
    assert.equal((await call('/api/sessions/one/model', 'PUT', sonnet)).status, 200);
    const reconnected = await connect();
    const fresh = await reconnected.next();
    assert(fresh.type === 'snapshot');
    assert.equal(fresh.sequence, 0);
    assert.equal(fresh.snapshot.agent.model?.modelId, sonnet.id, 'Reconnect must include changes made while disconnected');
    reconnected.socket.send(JSON.stringify({ type: 'setModel', model: opus }));
    assert.equal(await reconnected.closed, 1008);
    assert.deepEqual((await (await call('/api/sessions/one')).json() as { model: unknown }).model, sonnet, 'Socket writes must not mutate Pi');
    const oversized = await connect();
    await oversized.next();
    oversized.socket.send('x'.repeat(1025));
    assert.equal(await oversized.closed, 1009);
    const invalid = await connect();
    await invalid.next();
    invalid.socket.send('{');
    assert.equal(await invalid.closed, 1008);
    const held = [];
    for (let i = 0; i < 8; i++) { const connection = await connect(); await connection.next(); held.push(connection); }
    const limit = await upgrade(new URL('/api/sessions/one/events', base), { headers: { ...headers, Upgrade: 'websocket' } });
    assert.equal(limit.status, 429);
    assert.deepEqual(await limit.json(), { error: { code: 'connection_limit' } });
    held[0].socket.close(1000);
    await held[0].closed;
    await until(async () => {
      const response = await upgrade(new URL('/api/sessions/one/events', base), { headers: { ...headers, Upgrade: 'websocket' } });
      if (response.status === 429) { await response.text(); return false; }
      assert.equal(response.status, 101);
      assert(response.webSocket);
      sockets.push(response.webSocket);
      const replacement = reader(response.webSocket);
      assert.equal((await replacement.next()).type, 'snapshot');
      return true;
    });
    for (const connection of held.slice(1)) { connection.socket.close(1000); await connection.closed; }
    const healthy = await connect();
    await healthy.next();
    for (let i = 0; i < 40; i++) {
      const model = i % 2 === 0 ? opus : sonnet;
      assert.equal((await call('/api/sessions/one/model', 'PUT', model)).status, 200);
      const committed = await healthy.next();
      assert.equal(committed.type, 'events');
      assert.equal(committed.sequence, i + 1);
      assert(committed.type === 'events');
      assert(committed.events.some((event) => event.type === 'agent_changed' && event.agent.model?.modelId === model.id));
    }
    healthy.socket.send(JSON.stringify({ type: 'unsubscribe' }));
    assert.equal(await healthy.closed, 1000, 'Acknowledging clients must remain usable beyond 32 total frames');
    const slow = await connect('two', false);
    await slow.next();
    for (let i = 0; i < 32; i++) assert.equal((await call('/api/sessions/two/model', 'PUT', i % 2 === 0 ? opus : sonnet)).status, 200);
    assert.equal(await slow.closed, 1008, 'Unacknowledged event delivery must be bounded');
  } finally {
    for (const socket of sockets) { if (socket.readyState === 1) socket.close(1000); }
    await runtime.dispose();
  }
});

test('outbound snapshots enforce the 256 KiB boundary and reject oversized committed events', { timeout: 10_000, concurrency: true }, async () => {
  let reply = 'stream-fixture-marker';
  const runtime = new Miniflare({ ...worker, bindings: {
    TEAM_AUTH: JSON.stringify([{ id: 'owner', token, sessions: ['probe', 'limit', 'above', 'event'], resources: [] }]),
    MODEL_PROVIDER: sonnet.provider, MODEL_ID: sonnet.id, ANTHROPIC_API_KEY: 'local-fake-key',
  }, outboundService: async (request: Request) => {
    assert.equal(new URL(request.url).hostname, 'api.anthropic.com');
    return new WorkerResponse(providerStart + providerDelta(reply) + providerEnd, { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const sockets: WebSocket[] = [];
  try {
    const base = await runtime.ready;
    const call = (path: string, method = 'GET', body?: unknown) => fetch(new URL(path, base), {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
    });
    const complete = async (sessionId: string) => {
      assert.equal((await call('/adapters/webhook', 'POST', { sessionId, operationId: 'reply', input: 'hello' })).status, 202);
      await until(async () => {
        const response = await call(`/api/sessions/${sessionId}/operations/reply`);
        assert.equal(response.status, 200);
        const result = await response.json() as { status: string; text?: string };
        if (result.status !== 'done') return false;
        assert.equal(result.text, reply);
        return true;
      });
    };
    const connect = async (sessionId: string) => {
      const response = await upgrade(new URL(`/api/sessions/${sessionId}/events`, base), { headers: { ...headers, Upgrade: 'websocket' } });
      assert.equal(response.status, 101);
      assert(response.webSocket);
      sockets.push(response.webSocket);
      return { socket: response.webSocket, ...reader(response.webSocket) };
    };
    await complete('probe');
    const probe = await connect('probe');
    const sample = JSON.stringify(await probe.next());
    const copies = sample.split(reply).length - 1;
    assert(copies > 0, 'Snapshot must contain the committed model response');
    const overhead = Buffer.byteLength(sample) - copies * reply.length;
    const length = Math.floor((262_144 - overhead) / copies);
    reply = 'x'.repeat(length);
    await complete('limit');
    const limit = await connect('limit');
    const atLimit = await limit.next();
    assert.equal(atLimit.type, 'snapshot');
    assert.equal(Buffer.byteLength(JSON.stringify(atLimit)), 262_144, 'Exactly 256 KiB must remain deliverable');
    limit.socket.send(JSON.stringify({ type: 'unsubscribe' }));
    assert.equal(await limit.closed, 1000);
    reply += 'x';
    await complete('above');
    const above = await connect('above');
    assert.equal(await above.closed, 1009, 'A snapshot one text byte beyond the bound must close');
    assert.equal((await call('/api/sessions', 'POST', { sessionId: 'event' })).status, 201);
    const event = await connect('event');
    assert.equal((await event.next()).type, 'snapshot');
    reply = 'x'.repeat(262_145);
    await complete('event');
    assert.equal(await event.closed, 1009, 'Oversized committed event frames must also close');
  } finally {
    for (const socket of sockets) { if (socket.readyState === 1) socket.close(1000); }
    await runtime.dispose();
  }
});

test('outstanding bytes close a slow consumer before the 32-frame cap', { timeout: 10_000, concurrency: true }, async () => {
  let provider: ReadableStreamDefaultController<Uint8Array> | undefined;
  const runtime = new Miniflare({ ...worker, bindings: {
    TEAM_AUTH: JSON.stringify([{ id: 'owner', token, sessions: ['bytes'], resources: [] }]),
    MODEL_PROVIDER: sonnet.provider, MODEL_ID: sonnet.id, ANTHROPIC_API_KEY: 'local-fake-key',
  }, outboundService: async (request: Request) => {
    assert.equal(new URL(request.url).hostname, 'api.anthropic.com');
    return new WorkerResponse(new ReadableStream<Uint8Array>({ start(controller) { provider = controller; } }), {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  } });
  let socket: WebSocket | undefined;
  try {
    const base = await runtime.ready;
    const call = (path: string, body: unknown) => fetch(new URL(path, base), {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    assert.equal((await call('/adapters/webhook', { sessionId: 'bytes', operationId: 'reply', input: 'hello' })).status, 202);
    await until(async () => Boolean(provider));
    assert(provider);
    const response = await upgrade(new URL('/api/sessions/bytes/events', base), { headers: { ...headers, Upgrade: 'websocket' } });
    assert.equal(response.status, 101);
    socket = response.webSocket!;
    assert(socket);
    const client = reader(socket, false);
    let bytes = 0;
    let frames = 0;
    let lastBytes = 0;
    const receive = async () => {
      const frame = await client.next();
      lastBytes = Buffer.byteLength(JSON.stringify(frame));
      bytes += lastBytes;
      frames++;
      return frame;
    };
    assert.equal((await receive()).type, 'snapshot');
    provider.enqueue(new TextEncoder().encode(providerStart));
    for (let chunk = 0; chunk < 5; chunk++) {
      provider.enqueue(new TextEncoder().encode(providerDelta('x'.repeat(200_000))));
      let delivered = false;
      while (!delivered) {
        const frame = await receive();
        delivered = frame.type === 'events' && JSON.stringify(frame.events).includes('x'.repeat(200_000));
      }
    }
    assert(bytes >= 1_000_000 && bytes <= 1_048_576, 'A consumer just below the outstanding-byte bound must receive every chunk');
    // Size the final fixture delta using the preceding committed delta's envelope, not a server limit export.
    const padding = 'z'.repeat(1_048_576 - bytes - (lastBytes - 200_000));
    provider.enqueue(new TextEncoder().encode(providerDelta(padding)));
    const boundary = await receive();
    assert(boundary.type === 'events' && boundary.events.some((event) => event.type === 'message_update'
      && event.changes.some((change) => change.type === 'text_delta' && change.delta === padding)));
    assert.equal(bytes, 1_048_576, 'Exactly 1 MiB outstanding must remain deliverable');
    assert(frames < 31, 'The byte limit must be isolated from the frame-count limit');
    provider.enqueue(new TextEncoder().encode(providerDelta('!')));
    assert.equal(await client.closed, 1008, 'Crossing 1 MiB must close before 32 outstanding frames');
    assert.equal((await call('/api/sessions/bytes/abort', {})).status, 200);
  } finally {
    if (socket?.readyState === 1) socket.close(1000);
    await runtime.dispose();
  }
});
