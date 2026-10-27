import type { Hono } from 'hono';
import type { Extension, Registry } from '@earendil-works/pi-durable';
import type { AppEnv, Env } from './env';
import type { Principal } from '../../shared/contracts';
import { installExtension } from './registry';

export interface AdapterModule { create: () => Hono<AppEnv> }
export interface ToolContext { env: Env; principal: Principal; sessionId: string }
export interface ToolModule { create: (context: ToolContext) => Extension }
// Each feature owns exactly one directory/index.ts; directory names are URL namespaces.
const adapters = import.meta.glob<AdapterModule>('./adapters/*/index.ts', { eager: true });
const tools = import.meta.glob<ToolModule>('./tools/*/index.ts', { eager: true });
export function mountAdapters(app: Hono<AppEnv>): void {
  for (const [path, module] of Object.entries(adapters)) {
    const name = path.split('/')[2];
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('invalid_adapter_namespace');
    // Adapters MUST authenticate their own inbound protocol; they are not bearer routes.
    app.route(`/adapters/${name}`, module.create());
  }
}
export function installTools(registry: Registry, context: ToolContext): void {
  for (const [path, module] of Object.entries(tools)) {
    const extension = module.create(context);
    if (extension.name !== path.split('/')[2]) throw new Error('invalid_tool_namespace');
    installExtension(registry, extension);
  }
}
