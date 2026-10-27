import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { LIMITS } from '../../shared/contracts';
import type { AppEnv } from './env';
import { teamAuth, sessionAccess } from './auth';
import { mountAdapters } from './plugins';
export { SessionAgent } from './session';

const app = new Hono<AppEnv>();
app.onError((_error, c) => c.json({ error: { code: 'internal_error' } }, 500));
app.notFound((c) => c.json({ error: { code: 'not_found' } }, 404));
app.use('*', bodyLimit({ maxSize: LIMITS.requestBytes, onError: (c) => c.json({ error: { code: 'payload_too_large' } }, 413) }));
app.get('/health', (c) => c.json({ status: 'ok', service: 'remote-agent' }));
app.use('/api/*', teamAuth);
app.use('/api/sessions/:sessionId/*', sessionAccess);
const control = app.get('/api/sessions/:sessionId/runtime', async (c) => {
  const result = await c.env.SESSIONS.getByName(c.req.param('sessionId')).inspect();
  return c.json(result);
});
mountAdapters(app);
export type ControlApi = typeof control;
export default app;
