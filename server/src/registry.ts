import type { Extension, Registry } from "@earendil-works/pi-durable";
import { LIMITS } from "@remote-agent/agent-contract";

export function installExtension(registry: Registry, extension: Extension): void {
  const snapshot = registry.snapshot();
  if (snapshot.extension(extension.name)) throw new Error("extension_registration_conflict");
  const names = new Set(snapshot.tools().map(({ tool }) => tool.name));
  for (const tool of extension.tools ?? []) {
    if (names.has(tool.name) || names.size >= LIMITS.tools)
      throw new Error("tool_registration_conflict");
    names.add(tool.name);
  }
  registry.install(extension);
}
