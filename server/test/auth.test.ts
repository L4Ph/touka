import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { teamAuth } from '../src/auth';
import type { AppEnv } from '../src/env';

const token = 'local-auth-test-token-not-a-secret-0001';
const member = { id: 'tester', token, sessions: ['allowed'], resources: [] };
const app = new Hono<AppEnv>();
app.use('/api/*', teamAuth);
app.get('/api/principal', (c) => c.json(c.get('principal')));

test('configured team authentication exposes only the authenticated principal', async () => {
  const response = await app.request('/api/principal', {
    headers: { Authorization: `Bearer ${token}` },
  }, { TEAM_AUTH: JSON.stringify([member]) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'tester', sessions: ['allowed'], resources: [] });
});

const invalidConfigs = [
  { name: 'missing', config: undefined },
  { name: 'malformed JSON', config: '{not-json' },
  { name: 'mixed valid and invalid members', config: JSON.stringify([member, { ...member, id: 'invalid', token: 'short' }]) },
  { name: 'duplicate token', config: JSON.stringify([member, { ...member, id: 'duplicate' }]) },
];
for (const { name, config } of invalidConfigs) {
  test(`TEAM_AUTH ${name} rejects even a valid bearer`, async () => {
    const response = await app.request('/api/principal', {
      headers: { Authorization: `Bearer ${token}` },
    }, { TEAM_AUTH: config });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: { code: 'auth_unconfigured' } });
  });
}
