import { DurableObject } from "cloudflare:workers";
import { SANDBOX_IMAGE, SandboxRuntime, type Operation, type SnapshotStore } from "./runtime";

/** Internal binding only: do not expose this DO's RPC through a public HTTP route. */
export class SandboxContainer extends DurableObject {
  private runtime?: SandboxRuntime;
  private cancelled = new Set<string>();
  async run(id: string, operation: Operation) {
    if (this.cancelled.delete(id)) throw new Error("sandbox_aborted");
    if (!this.ctx.container) throw new Error("sandbox_unconfigured");
    this.runtime ??= new SandboxRuntime(this.ctx.container, this.snapshots());
    return this.runtime.run(id, operation);
  }
  /** A snapshot only restores onto the image it was taken from, so a new image starts clean. */
  private snapshots(): SnapshotStore {
    const image = SANDBOX_IMAGE;
    return {
      load: async () => {
        const saved = await this.ctx.storage.get<{ image: string; snapshot: ContainerSnapshot }>(
          "snapshot",
        );
        return saved?.image === image ? saved.snapshot : undefined;
      },
      save: (snapshot) => this.ctx.storage.put("snapshot", { image, snapshot }),
    };
  }
  async cancel(id: string) {
    // Handle a cancel arriving before run; keep the memory footprint bounded.
    if (this.cancelled.size >= 64) this.cancelled.delete(this.cancelled.values().next().value!);
    this.cancelled.add(id);
    await this.runtime?.cancel(id);
  }
}
