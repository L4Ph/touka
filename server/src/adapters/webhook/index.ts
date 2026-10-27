import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { teamAuth } from '../../auth';
import { isSubmitInput } from '../../../../shared/contracts';

export function create(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', teamAuth);
  app.post('/', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); }
    catch { return c.json({ error: { code: 'invalid_payload' } }, 400); }
    if (!isSubmitInput(body)) return c.json({ error: { code: 'invalid_payload' } }, 400);
    if (!c.get('principal').sessions.includes(body.sessionId)) return c.json({ error: { code: 'forbidden' } }, 403);
    const receipt = await c.env.SESSIONS.getByName(body.sessionId).submit({
      ...body, input: body.input.replace(/\r\n?/g, '\n').trim(),
    });
    if (!receipt) return c.json({ error: { code: 'queue_full' } }, 429);
    return c.json(receipt, 202);
  });
  return app;
}
