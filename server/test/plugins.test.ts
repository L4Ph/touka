import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'vite';

test('directory-owned adapters and tools are discovered, namespaced and usable after a production build', async () => {
  // Keep the fixture in this workspace so bundled code resolves the installed dependencies.
  const root = await mkdtemp(resolve('.plugin-fixture-'));
  try {
    const src = resolve(root, 'server/src');
    await mkdir(resolve(src, 'adapters/probe'), { recursive: true });
    await mkdir(resolve(src, 'tools/probe'), { recursive: true });
    await mkdir(resolve(root, 'shared'));
    await cp('src/plugins.ts', resolve(src, 'plugins.ts'));
    await cp('src/registry.ts', resolve(src, 'registry.ts'));
    await cp('../shared/contracts.ts', resolve(root, 'shared/contracts.ts'));
    await writeFile(resolve(src, 'index.ts'), `
      import { Hono } from 'hono';
      import { mountAdapters } from './plugins';
      const app = new Hono();
      mountAdapters(app);
      export default app;
    `);
    await writeFile(resolve(src, 'adapters/probe/index.ts'), `
      import { Hono } from 'hono';
      import { createRegistry } from '@earendil-works/pi-durable';
      import { installTools } from '../../plugins';
      export function create() {
        return new Hono().get('/run', async (c) => {
          const registry = createRegistry();
          installTools(registry, {
            env: {}, sessionId: 'fixture-session',
            principal: { id: 'fixture-member', sessions: ['fixture-session'], resources: [] },
          });
          const registered = registry.snapshot().tools().find(({ tool }) => tool.name === 'probe_uppercase');
          if (!registered) return c.json({ error: 'tool_missing' }, 503);
          return c.json(await registered.tool.execute({ text: c.req.query('text') }));
        });
      }
    `);
    await writeFile(resolve(src, 'tools/probe/index.ts'), `
      import { Type } from '@earendil-works/pi-ai';
      export function create(context) {
        return { name: 'probe', tools: [{
          name: 'probe_uppercase', description: 'Uppercase fixture input', replay: 'safe',
          parameters: Type.Object({ text: Type.String() }),
          execute: async ({ text }) => ({ text: text.toUpperCase(), sessionId: context.sessionId }),
        }] };
      }
    `);
    await build({
      root, configFile: false, logLevel: 'silent',
      build: { ssr: resolve(src, 'index.ts'), outDir: resolve(root, 'dist'), target: 'esnext', minify: false },
    });
    const { default: app } = await import(pathToFileURL(resolve(root, 'dist/index.js')).href);
    const response = await app.request('http://fixture/adapters/probe/run?text=directory-owned');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'DIRECTORY-OWNED', sessionId: 'fixture-session' });
    assert.equal((await app.request('http://fixture/probe/run?text=wrong-namespace')).status, 404);
    assert.equal((await app.request('http://fixture/adapters/other/run?text=wrong-adapter')).status, 404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
