import { DurableObject } from "cloudflare:workers";
import type { Duplex } from "./connection";
import type { EgressProps } from "./policy";
import { SANDBOX_RUNTIME, startupOptions, TRUST_ENV } from "./image";
import { serial } from "../serial";
import packages from "../../sandbox-packages.txt?raw";

/** The pi-env daemon the tools talk to, pinned by checksum and fetched once per container. */
const DAEMON_VERSION = "1.5.0";
// A versioned path avoids overwriting an executable still serving an older Worker instance.
const DAEMON_PATH = `/tmp/touka/pi-env-${DAEMON_VERSION}`;
const DAEMON = {
  x64: {
    sha256: "55419f4fa1e7059f52540a2035ca68e90cc2c3ac49b637a7134c0200c2ab3381",
    url: `https://unpkg.com/@earendil-works/pi-env@${DAEMON_VERSION}/bin/pi-env-linux-x64/pi-env`,
  },
  arm64: {
    sha256: "e967fe64bd3f765f5e5ce9d3b83bfebcda24b5e929b82d93491b0803048d0ad5",
    url: `https://unpkg.com/@earendil-works/pi-env@${DAEMON_VERSION}/bin/pi-env-linux-arm64/pi-env`,
  },
} as const;

const installScript = `const fs=require('fs'),crypto=require('crypto'),path=require('path');
const [dest,table]=process.argv.slice(1),d=JSON.parse(table)[process.arch];
if(!d){console.error('unsupported arch '+process.arch);process.exit(1)}
const ok=()=>{try{return crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')===d.sha256}catch{return false}};
(async()=>{if(ok())return;const r=await fetch(d.url);if(!r.ok)throw new Error('download '+r.status);
fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,Buffer.from(await r.arrayBuffer()),{mode:0o755});
if(!ok())throw new Error('checksum mismatch')})().catch(e=>{console.error(e.message);process.exit(1)});`;

/** Internal binding only: do not expose this DO's RPC through a public HTTP route. */
export class SandboxContainer extends DurableObject {
  private readonly exclusive = serial();
  /**
   * Opens the pi-env daemon in this session's container, starting the container if needed. `props`
   * says which GitHub repositories the container's own traffic may reach; the container itself
   * holds no credential.
   */
  async daemon(token: string, props: EgressProps): Promise<Duplex> {
    return this.exclusive(async () => {
      const container = this.ctx.container;
      if (!container) throw new Error("sandbox_unconfigured");
      if (
        container.running &&
        (await container.inspect())?.labels["touka.runtime"] !== SANDBOX_RUNTIME
      ) {
        // Never destroy an old workspace unless its current filesystem was successfully saved.
        await this.snapshot();
        await container.destroy();
      }
      if (!container.running) {
        const saved = await this.ctx.storage.get<{ snapshot: ContainerSnapshot }>("snapshot");
        container.start(startupOptions(saved?.snapshot, container.images.tools));
      }
      // Intercepts last until the container stops, so they are registered again every time.
      const egress = (
        this.ctx.exports as unknown as Record<string, (init: { props: EgressProps }) => Fetcher>
      ).GitHubEgress!({ props });
      await container.interceptOutboundHttps("*", egress);
      await container.interceptOutboundHttp("*", egress);
      // Legacy snapshots keep their old image. Repair missing baseline tools once, after resizing.
      const prepare = await container.exec(
        [
          "bash",
          "-c",
          'missing=0; for tool in git git-lfs gh curl jq python3 make g++ ps rg unzip zip ssh; do command -v "$tool" >/dev/null || missing=1; done; ' +
            'if [ "$missing" = 1 ]; then export DEBIAN_FRONTEND=noninteractive; timeout 180 dpkg --configure -a && timeout 180 apt-get update -qq && timeout 180 apt-get install -y --no-install-recommends "$@"; fi',
          "touka-bootstrap",
          ...packages.trim().split(/\s+/),
        ],
        { env: { ...TRUST_ENV }, stdout: "ignore", stderr: "pipe" },
      );
      const prepared = await prepare.output();
      if (prepared.exitCode !== 0) {
        console.error(
          "sandbox_bootstrap_failed",
          prepared.exitCode,
          new TextDecoder()
            .decode(prepared.stderr)
            .slice(-2000)
            .replace(/(https?:\/\/)[^\s/]+@/g, "$1[redacted]@"),
        );
        throw new Error("sandbox_bootstrap_failed");
      }
      // Also the readiness probe: it only succeeds once the container accepts commands.
      const install = await container.exec(
        ["node", "-e", installScript, DAEMON_PATH, JSON.stringify(DAEMON)],
        { env: { ...TRUST_ENV }, stdout: "pipe", stderr: "pipe" },
      );
      if ((await install.exitCode) !== 0) throw new Error("sandbox_transport_error");
      await (
        await container.exec(["mkdir", "-p", "/workspace"])
      ).exitCode;
      const daemon = await container.exec([DAEMON_PATH, "serve", "--token", token], {
        cwd: "/workspace",
        env: { ...TRUST_ENV },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      });
      // An extra best-effort save; tool completion checkpoints do not depend on daemon exit.
      this.ctx.waitUntil(
        daemon.exitCode
          .then(() => this.exclusive(() => this.snapshot()))
          .catch(() => console.error("sandbox_snapshot_failed")),
      );
      return { stdin: daemon.stdin!, stdout: daemon.stdout! };
    });
  }

  checkpoint(): Promise<void> {
    return this.exclusive(() => this.snapshot());
  }

  private async snapshot(): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running || !container.snapshotContainer)
      throw new Error("sandbox_snapshot_unavailable");
    const snapshot = await container.snapshotContainer({ name: "workspace" });
    // Retain the legacy reader's guard; the opaque snapshot, not this marker, owns the actual image.
    await this.ctx.storage.put("snapshot", {
      image: "cloudflare/debian-trixie",
      snapshot,
      savedAt: Date.now(),
    });
    console.info("sandbox_checkpoint_saved", { id: snapshot.id, size: snapshot.size });
  }
}
