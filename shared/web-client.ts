import { hc } from "hono/client";
import type { ControlApi } from "../server/src/index";

// Use the same typed control API through the cookie-authenticated same-origin Void proxy.
export function teamClient(origin: string) {
  return hc<ControlApi>(origin, {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input), origin);
      url.pathname = url.pathname.replace(/^\/api\//, "/api/agent/");
      return globalThis.fetch(url, { ...init, credentials: "same-origin" });
    },
  });
}
export type { ControlApi };
export type { SessionStreamFrame } from "./stream";
