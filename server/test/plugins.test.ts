import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { build } from "vite";

test("workspace adapters and directory tools are discovered and usable after a production build", async () => {
  const root = await mkdtemp(resolve(".plugin-fixture-"));
  try {
    const src = resolve(root, "server/src");
    const adapter = resolve(root, "packages/adapter-probe/src");
    await mkdir(adapter, { recursive: true });
    await mkdir(resolve(src, "tools/probe"), { recursive: true });
    await cp("src/plugins.ts", resolve(src, "plugins.ts"));
    await cp("src/registry.ts", resolve(src, "registry.ts"));
    // This fixture composes a real tool registry behind the same typed package capability.
    await writeFile(
      resolve(src, "adapter.ts"),
      `
      import { createRegistry } from '@earendil-works/pi-durable';
      import { installTools } from './plugins';
      export const adapterDependencies = { submit: async (_env, input) => {
        const registry = createRegistry();
        installTools(registry, { env: {}, sessionId: input.sessionId,
          principal: { id: 'fixture-member', sessions: [input.sessionId], resources: [] } });
        const registered = registry.snapshot().tools().find(({ tool }) => tool.name === 'probe_uppercase');
        if (!registered) throw new Error('tool_missing');
        return registered.tool.execute({ text: input.input });
      } };
    `,
    );
    await writeFile(
      resolve(src, "index.ts"),
      `
      import { Hono } from 'hono';
      import { mountAdapters } from './plugins';
      const app = new Hono();
      mountAdapters(app);
      export default app;
    `,
    );
    await writeFile(
      resolve(adapter, "index.ts"),
      `
      import { Hono } from 'hono';
      export function create({ submit }) {
        return new Hono().get('/run', async (c) => c.json(await submit(c.env, {
          sessionId: 'fixture-session', operationId: 'fixture-op', input: c.req.query('text'),
        })));
      }
    `,
    );
    await writeFile(
      resolve(src, "tools/probe/index.ts"),
      `
      import { Type } from '@earendil-works/pi-ai';
      export function create(context) {
        return { name: 'probe', tools: [{
          name: 'probe_uppercase', description: 'Uppercase fixture input', replay: 'safe',
          parameters: Type.Object({ text: Type.String() }),
          execute: async ({ text }) => ({ text: text.toUpperCase(), sessionId: context.sessionId }),
        }] };
      }
    `,
    );
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      build: {
        ssr: resolve(src, "index.ts"),
        outDir: resolve(root, "dist"),
        target: "esnext",
        minify: false,
      },
    });
    const { default: app } = await import(pathToFileURL(resolve(root, "dist/index.js")).href);
    const response = await app.request("http://fixture/adapters/probe/run?text=directory-owned");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      text: "DIRECTORY-OWNED",
      sessionId: "fixture-session",
    });
    assert.equal((await app.request("http://fixture/probe/run?text=wrong-namespace")).status, 404);
    assert.equal(
      (await app.request("http://fixture/adapters/other/run?text=wrong-adapter")).status,
      404,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
