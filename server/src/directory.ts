import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { validId } from "@remote-agent/agent-contract";

// One team-wide index, not a second conversation store. IDs are immutable and cursors lexical.
export class SessionDirectory extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)");
  }
  async register(id: string) {
    if (!validId(id)) throw new Error("invalid_session");
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO sessions (id) VALUES (?)", id);
  }
  async page(after = "", limit = 50) {
    if ((after && !validId(after)) || !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("invalid_page");
    const rows = this.ctx.storage.sql
      .exec<{ id: string }>(
        "SELECT id FROM sessions WHERE id > ? ORDER BY id LIMIT ?",
        after,
        limit + 1,
      )
      .toArray();
    return {
      ids: rows.slice(0, limit).map((row) => row.id),
      next: rows.length > limit ? rows[limit - 1].id : null,
    };
  }
}
