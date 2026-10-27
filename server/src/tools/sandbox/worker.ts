import { DurableObject } from "cloudflare:workers";
import { SandboxRuntime, type Operation } from "./runtime";

/** Internal binding only: do not expose this DO's RPC through a public HTTP route. */
export class SandboxSession extends DurableObject {
  private runtime?: SandboxRuntime;
  private cancelled = new Set<string>();
  async run(id: string, operation: Operation) {
    if (this.cancelled.delete(id)) throw new Error("sandbox_aborted");
    if (!this.ctx.container) throw new Error("sandbox_unconfigured");
    this.runtime ??= new SandboxRuntime(this.ctx.container);
    return this.runtime.run(id, operation);
  }
  async cancel(id: string) {
    // Handle a cancel arriving before run; keep the memory footprint bounded.
    if (this.cancelled.size >= 64) this.cancelled.delete(this.cancelled.values().next().value!);
    this.cancelled.add(id);
    await this.runtime?.cancel(id);
  }
}
