import type { Hono } from "hono";
import type { Extension, Registry } from "@earendil-works/pi-durable";
import type { AppEnv, Env } from "./env";
import type { Principal } from "@remote-agent/adapter-contract";
import { installExtension } from "./registry";

import { adapterDependencies } from "./adapter";
import type { AdapterModule, DeliveryHandler } from "@remote-agent/adapter-contract";
export interface ToolContext {
  env: Env;
  principal: Principal;
  sessionId: string;
}
export interface ToolModule {
  create: (context: ToolContext) => Extension;
}
// Package directories are URL namespaces. Adding a package needs no central registration edit.
const adapters = import.meta.glob<AdapterModule>(
  ["../../packages/adapter-*/src/index.ts", "!../../packages/adapter-contract/**"],
  { eager: true },
);
const adapterName = (path: string) => path.split("/")[3].slice("adapter-".length);
const tools = import.meta.glob<ToolModule>("./tools/*/index.ts", { eager: true });
export function mountAdapters(app: Hono<AppEnv>): void {
  for (const [path, module] of Object.entries(adapters)) {
    const name = adapterName(path);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("invalid_adapter_namespace");
    // Adapters MUST authenticate their own inbound protocol; they are not bearer routes.
    app.route(`/adapters/${name}`, module.create(adapterDependencies));
  }
}
export function deliveryHandlers(): Record<string, DeliveryHandler> {
  return Object.fromEntries(
    Object.entries(adapters)
      .filter(([, module]) => module.deliver)
      .map(([path, module]) => [adapterName(path), module.deliver!]),
  );
}
export function installTools(registry: Registry, context: ToolContext): void {
  for (const [path, module] of Object.entries(tools)) {
    const extension = module.create(context);
    if (extension.name !== path.split("/")[2]) throw new Error("invalid_tool_namespace");
    installExtension(registry, extension);
  }
}
