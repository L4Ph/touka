import type nodeAssert from "node:assert/strict";
import type { ToolRegistration } from "@earendil-works/pi-durable";
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

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { Type } = await import("@earendil-works/pi-ai");
  const { createRegistry } = await import("@earendil-works/pi-durable");

  function tool(name: string): ToolRegistration {
    return {
      name,
      description: "Test registration only",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        throw new Error("Registration test must not execute a tool");
      },
    };
  }

  test("extensions retain both modules and reject collisions without replacing installed tools", () => {
    const registry = createRegistry();
    installExtension(registry, { name: "github", tools: [tool("github_read")] });
    installExtension(registry, { name: "sandbox", tools: [tool("sandbox_run")] });
    assert.deepEqual(
      registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool.name),
      ["github_read", "sandbox_run"],
    );
    assert.throws(
      () => installExtension(registry, { name: "github", tools: [] }),
      /extension_registration_conflict/,
    );
    assert.throws(
      () => installExtension(registry, { name: "other", tools: [tool("github_read")] }),
      /tool_registration_conflict/,
    );
    assert.equal(registry.snapshot().extension("other"), undefined);
    assert.equal(registry.snapshot().tools().length, 2);
  });

  test("tool registration cap rejects the whole overflowing extension", () => {
    const registry = createRegistry();
    installExtension(registry, {
      name: "full",
      tools: Array.from({ length: 32 }, (_, i) => tool(`tool_${i}`)),
    });
    assert.throws(
      () => installExtension(registry, { name: "overflow", tools: [tool("extra")] }),
      /tool_registration_conflict/,
    );
    assert.equal(registry.snapshot().tools().length, 32);
    assert.equal(registry.snapshot().extension("overflow"), undefined);
  });
}
