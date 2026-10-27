import type { Hono } from "hono";
import type { AppEnv } from "./env";

import { triggerDependencies } from "./trigger";
import type { TriggerModule, DeliveryHandler } from "@remote-agent/trigger-contract";
// Package directories are URL namespaces. Adding a package needs no central registration edit.
const triggers = import.meta.glob<TriggerModule>(
  ["../../packages/trigger-*/src/index.ts", "!../../packages/trigger-contract/**"],
  { eager: true },
);
const triggerName = (path: string) => path.split("/")[3].slice("trigger-".length);
export function mountTriggers(app: Hono<AppEnv>): void {
  for (const [path, module] of Object.entries(triggers)) {
    const name = triggerName(path);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("invalid_trigger_namespace");
    // Triggers MUST authenticate their own inbound protocol; they are not bearer routes.
    app.route(`/triggers/${name}`, module.create(triggerDependencies));
  }
}
export function deliveryHandlers(): Record<string, DeliveryHandler> {
  return Object.fromEntries(
    Object.entries(triggers)
      .filter(([, module]) => module.deliver)
      .map(([path, module]) => [triggerName(path), module.deliver!]),
  );
}
