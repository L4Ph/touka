import { Hono } from "hono";
import {
  isSubmitInput,
  type AdapterAppEnv,
  type AdapterDependencies,
} from "@remote-agent/adapter-contract";

export function create({ authenticate, submit }: AdapterDependencies): Hono<AdapterAppEnv> {
  const app = new Hono<AdapterAppEnv>();
  app.use("*", authenticate);
  app.post("/", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "invalid_payload" } }, 400);
    }
    if (!isSubmitInput(body)) return c.json({ error: { code: "invalid_payload" } }, 400);
    if (!c.get("principal").sessions.includes(body.sessionId))
      return c.json({ error: { code: "forbidden" } }, 403);
    const receipt = await submit(
      c.env,
      {
        ...body,
        input: body.input.replace(/\r\n?/g, "\n").trim(),
      },
      c.get("principal"),
    );
    if (!receipt) return c.json({ error: { code: "queue_full" } }, 429);
    return c.json(receipt, 202);
  });
  return app;
}
