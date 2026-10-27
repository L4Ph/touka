import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { globSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Miniflare, Response as WorkerResponse } from 'miniflare';
import { sessionModels, modelError, modelCatalog } from '../src/models';
import type { Env } from '../src/env';

const token = 'sessions-local-token-not-a-secret-0001';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const sonnet = { provider: 'anthropic', id: 'claude-sonnet-4-5' };
const opus = { provider: 'anthropic', id: 'claude-opus-4-5' };
const worker = {
  modules: ['dist/remote_agent_server/index.js', ...globSync('dist/remote_agent_server/assets/*.js')]
    .map((path) => ({ type: 'ESModule' as const, path })),
  compatibilityDate: '2026-08-01', compatibilityFlags: ['nodejs_compat'],
  durableObjects: { SESSIONS: { className: 'SessionAgent', useSQLite: true } },
};

async function until<T>(read: () => Promise<T>, matches: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (matches(value)) return value;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for session state');
}

test('authorized session controls persist the real Pi model and transcript and abort running work', { timeout: 45_000 }, async () => {
  const state = await mkdtemp(join(tmpdir(), 'pi-sessions-'));
  const requests: { model: string }[] = [];
  const options = {
    ...worker, durableObjectsPersist: state,
    bindings: {
      TEAM_AUTH: JSON.stringify([
        { id: 'owner', token, sessions: ['one', 'empty'], resources: [] },
        { id: 'other', token: `${token}other`, sessions: ['private'], resources: [] },
      ]),
      MODEL_PROVIDER: sonnet.provider, MODEL_ID: sonnet.id, ANTHROPIC_API_KEY: 'local-fake-key',
    },
    outboundService: async (request: Request) => {
      assert.equal(new URL(request.url).hostname, 'api.anthropic.com');
      requests.push(await request.json() as { model: string });
      return new WorkerResponse(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } });
    },
  };
  let runtime = new Miniflare(options);
  let url = await runtime.ready;
  const call = (path: string, method = 'GET', body?: unknown, customHeaders = headers) => fetch(new URL(path, url), {
    method, headers: customHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000),
  });
  const summary = async () => (await call('/api/sessions/one')).json() as Promise<{ model: unknown; busy: boolean; pending: { status: string }[] }>;
  try {
    assert.deepEqual(await (await call('/api/sessions')).json(), { sessions: [] });
    assert.equal((await call('/api/sessions/one')).status, 404);
    assert.equal((await call('/api/sessions', 'POST', { sessionId: 'private' })).status, 403);
    assert.equal((await call('/api/sessions', 'POST', { sessionId: 'one', apiKey: 'never-store' })).status, 400);
    assert.equal((await call('/api/sessions', 'POST', { sessionId: 'one', model: { provider: 'invented', id: 'made-up' } })).status, 400);
    assert.equal((await call('/api/sessions', 'POST', { sessionId: 'one' })).status, 201);
    assert.deepEqual((await summary()).model, sonnet, 'Creation must apply server defaults');
    assert.equal((await call('/api/sessions', 'POST', { sessionId: 'one' })).status, 409);
    assert.equal((await call('/api/sessions', 'POST', { sessionId: 'empty', model: opus })).status, 201);
    assert.equal((await call('/api/sessions/one/model', 'PUT', { ...opus, apiKey: 'never-store' })).status, 400);
    assert.equal((await call('/api/sessions/one/model', 'PUT', { provider: 'openai', id: 'gpt-4o' })).status, 503);
    assert.equal((await call('/api/sessions/one/model', 'PUT', { provider: 'anthropic', id: 'nonexistent' })).status, 400);
    assert.deepEqual((await summary()).model, sonnet, 'Rejected settings must not overwrite the durable selection');
    assert.equal((await call('/api/sessions/one/model', 'PUT', opus)).status, 200);
    const catalog = await (await call('/api/models')).json() as { providers: { provider: string; transport: string; configured: boolean; models: { api: string; id: string }[] }[] };
    const gateway = catalog.providers.find((provider) => provider.provider === 'cloudflare-ai-gateway');
    assert(gateway);
    assert.equal(gateway.transport, 'cloudflare-gateway');
    assert.equal(gateway.configured, false);
    assert(gateway.models.length > 0);
    assert(gateway.models.every((model) => ['anthropic-messages', 'openai-completions', 'openai-responses'].includes(model.api)));
    assert.equal(catalog.providers.find((provider) => provider.provider === 'anthropic')?.transport, 'native');
    assert.equal(JSON.stringify(catalog).includes('local-fake-key'), false);
    for (const [path, method, body] of [
      ['/api/sessions/one', 'GET', undefined],
      ['/api/sessions/one/messages', 'GET', undefined],
      ['/api/sessions/one/model', 'PUT', sonnet],
      ['/api/sessions/one/abort', 'POST', {}],
      ['/api/sessions/one/retry', 'POST', undefined],
    ] as const) {
      assert.equal((await call(path, method, body, { ...headers, Authorization: `Bearer ${token}other` })).status, 403);
    }
    await runtime.dispose();
    runtime = new Miniflare(options);
    url = await runtime.ready;
    assert.deepEqual((await summary()).model, opus, 'Pi configuration must survive reopen without reverting to environment defaults');
    const listed = await (await call('/api/sessions')).json() as { sessions: { sessionId: string; model: unknown }[] };
    assert.deepEqual(listed.sessions.map(({ sessionId, model }) => ({ sessionId, model })).sort((a, b) => a.sessionId.localeCompare(b.sessionId)), [
      { sessionId: 'empty', model: opus },
      { sessionId: 'one', model: opus },
    ]);
    const explicit = await (await call('/api/sessions/empty')).json() as { model: unknown };
    assert.deepEqual(explicit.model, opus, 'Explicit nondefault creation must persist across reopen');
    assert.equal((await call('/adapters/webhook', 'POST', { sessionId: 'one', operationId: 'stop-me', input: 'Remember this sentence' })).status, 202);
    await until(summary, (value) => value.pending.some((operation) => operation.status === 'running'));
    await until(async () => requests.length, (count) => count === 1);
    assert.equal(requests[0].model, opus.id, 'The selected registry model must actually be used');
    assert.equal((await call('/api/sessions/one/abort', 'POST', { operationId: '../bad' })).status, 400);
    assert.deepEqual(await (await call('/api/sessions/one/abort', 'POST', {})).json(), { aborted: true });
    const status = async () => (await call('/api/sessions/one/operations/stop-me')).json() as Promise<{ status: string; reason: string }>;
    const stopped = await until(status, (value) => value.status === 'unanswered');
    assert.equal(stopped.reason, 'aborted');
    assert.equal((await summary()).busy, false);
    const transcript = await (await call('/api/sessions/one/messages')).json() as { messages: { kind: string; model?: { content: unknown }[] }[] };
    assert(transcript.messages.some((entry) => entry.kind === 'pi.user' && JSON.stringify(entry.model).includes('Remember this sentence')));
    await runtime.dispose();
    runtime = new Miniflare(options);
    url = await runtime.ready;
    assert.deepEqual(await (await call('/api/sessions/one/messages')).json(), transcript);
    assert.deepEqual(await status(), stopped);
    assert.deepEqual(await (await call('/api/sessions/one/retry', 'POST')).json(), { retried: false }, 'Unanswered is terminal, not parked');
  } finally {
    await runtime.dispose();
    await rm(state, { recursive: true, force: true });
  }
});

test('Gateway selection requires each server credential and accepts a real registry model when configured', { timeout: 20_000 }, async () => {
  const credentials = {
    CLOUDFLARE_API_KEY: 'local-gateway-key',
    CLOUDFLARE_ACCOUNT_ID: 'local-account',
    CLOUDFLARE_GATEWAY_ID: 'local-gateway',
  };
  const model = { provider: 'cloudflare-ai-gateway', id: 'claude-sonnet-4-5' };
  for (const missing of [null, ...Object.keys(credentials)]) {
    // Only credential fields are read by the model registry; no DO binding is used.
    const env = Object.fromEntries(Object.entries(credentials).filter(([key]) => key !== missing)) as unknown as Env;
    const configured = missing === null;
    const models = sessionModels(env);
    assert.equal(Boolean(await models.getAuth(model.provider)), configured, `Gateway auth with missing ${missing}`);
    assert.equal(await modelError(env, model), configured ? null : 'model_unconfigured', `Gateway selection with missing ${missing}`);
    const catalog = await modelCatalog(env);
    assert.equal(catalog.find((entry) => entry.provider === model.provider)?.configured, configured, `Gateway catalog with missing ${missing}`);
  }
  const runtime = new Miniflare({ ...worker, bindings: {
    TEAM_AUTH: JSON.stringify([{ id: 'owner', token, sessions: ['gateway'], resources: [] }]),
    ...credentials,
  } });
  try {
    const url = await runtime.ready;
    const response = await fetch(new URL('/api/sessions', url), {
      method: 'POST', headers, body: JSON.stringify({ sessionId: 'gateway', model }),
    });
    assert.equal(response.status, 201);
    const session = await fetch(new URL('/api/sessions/gateway', url), { headers });
    assert.equal(session.status, 200);
    assert.deepEqual((await session.json() as { model: unknown }).model, model);
  } finally { await runtime.dispose(); }
});

test('session creation fails closed for incomplete defaults and Gateway credentials', { timeout: 20_000 }, async () => {
  const runtime = new Miniflare({ ...worker, bindings: {
    TEAM_AUTH: JSON.stringify([{ id: 'owner', token, sessions: ['one'], resources: [] }]),
    MODEL_PROVIDER: 'anthropic',
  } });
  try {
    const url = await runtime.ready;
    const create = (body: unknown) => fetch(new URL('/api/sessions', url), { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal((await create({ sessionId: 'one' })).status, 503);
    assert.equal((await create({ sessionId: 'one', model: sonnet })).status, 503);
    const catalogResponse = await fetch(new URL('/api/models', url), { headers });
    const catalog = await catalogResponse.json() as { providers: { provider: string; models: { id: string }[] }[] };
    const gateway = catalog.providers.find((provider) => provider.provider === 'cloudflare-ai-gateway');
    assert(gateway?.models[0]);
    assert.equal((await create({ sessionId: 'one', model: { provider: gateway.provider, id: gateway.models[0].id } })).status, 503);
    assert.deepEqual(await (await fetch(new URL('/api/sessions', url), { headers })).json(), { sessions: [] });
    assert.equal((await fetch(new URL('/api/sessions/one', url), { headers })).status, 404, 'Rejected configuration must not create a session');
  } finally { await runtime.dispose(); }
});
