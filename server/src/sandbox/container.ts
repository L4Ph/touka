import { DurableObject } from "cloudflare:workers";
import type { Duplex } from "./connection";
import type { EgressProps } from "./policy";
import { SANDBOX_IMAGE, TRUST_ENV } from "./image";

/** The pi-env daemon the tools talk to, pinned by checksum and fetched once per container. */
const DAEMON_VERSION = "1.4.0";
const DAEMON_PATH = "/tmp/touka/pi-env";
const DAEMON = {
  x64: {
    sha256: "46dde0e25b5cf1a327a10ddcb25f746f85b783492f5b225dfaa1a0d84cf5b56a",
    url: `https://unpkg.com/@earendil-works/pi-env@${DAEMON_VERSION}/bin/pi-env-linux-x64/pi-env`,
  },
  arm64: {
    sha256: "2a98a5576aed5f24b1b218e3025dcf6a2ea005ecbd8115aef63e443e6e8bffb8",
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
  /**
   * Opens the pi-env daemon in this session's container, starting the container if needed. `props`
   * says which GitHub repositories the container's own traffic may reach; the container itself
   * holds no credential.
   */
  async daemon(token: string, props: EgressProps): Promise<Duplex> {
    const container = this.ctx.container;
    if (!container) throw new Error("sandbox_unconfigured");
    if (!container.running) {
      // A destroyed container restarts from the last good snapshot.
      const saved = await this.ctx.storage.get<{ image: string; snapshot: ContainerSnapshot }>(
        "snapshot",
      );
      const containerSnapshot = saved?.image === SANDBOX_IMAGE ? saved.snapshot : undefined;
      container.start({
        ...(containerSnapshot ? { containerSnapshot } : { image: SANDBOX_IMAGE }),
        entrypoint: ["sleep", "infinity"],
        enableInternet: true,
        env: {},
      });
    }
    // Intercepts last until the container stops, so they are registered again every time.
    const egress = (
      this.ctx.exports as unknown as Record<string, (init: { props: EgressProps }) => Fetcher>
    ).GitHubEgress!({ props });
    await container.interceptOutboundHttps("*", egress);
    await container.interceptOutboundHttp("*", egress);
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
    // The workspace outlives the container only through a snapshot, taken when the daemon ends.
    this.ctx.waitUntil(daemon.exitCode.then(() => this.snapshot()).catch(() => {}));
    return { stdin: daemon.stdin!, stdout: daemon.stdout! };
  }

  /** Best-effort: a failed snapshot keeps the previous one. */
  private async snapshot(): Promise<void> {
    const container = this.ctx.container;
    if (!container?.running || !container.snapshotContainer) return;
    try {
      const snapshot = await container.snapshotContainer({ name: "workspace" });
      await this.ctx.storage.put("snapshot", { image: SANDBOX_IMAGE, snapshot });
    } catch {
      // ponytail: silent; surface it if lost workspaces ever matter.
    }
  }
}
