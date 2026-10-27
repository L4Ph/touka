import type { Extension, Registry } from "@earendil-works/pi-durable";
import type { Principal } from "@remote-agent/agent-contract";
import type { Env } from "./env";
import { installExtension } from "./registry";

export interface ToolContext {
  env: Env;
  principal: Principal;
  sessionId: string;
}
export interface ToolModule {
  create: (context: ToolContext) => Extension;
}
const tools = import.meta.glob<ToolModule>("./tools/*/index.ts", { eager: true });
export function installTools(registry: Registry, context: ToolContext): void {
  for (const [path, module] of Object.entries(tools)) {
    const extension = module.create(context);
    if (extension.name !== path.split("/")[2]) throw new Error("invalid_tool_namespace");
    installExtension(registry, extension);
  }
}
