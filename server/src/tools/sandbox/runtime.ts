export const LIMITS = {
  inputBytes: 32_768,
  outputBytes: 65_536,
  timeoutMs: 10_000,
  // Builds and test suites are long; the shell gets minutes where one-off scripts get seconds.
  shellTimeoutMs: 600_000,
  checkoutTimeoutMs: 180_000,
  archiveBytes: 200_000_000,
} as const;
/** Cloudflare-managed image (Node.js on Debian Trixie). Snapshots only restore onto the image they came from. */
export const SANDBOX_IMAGE = "cloudflare/debian-trixie";
export type Operation =
  | { kind: "execute"; code: string; timeoutMs: number }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string }
  | { kind: "shell"; command: string; timeoutMs: number; cwd?: string }
  | { kind: "checkout"; dir: string; archive: ReadableStream<Uint8Array> }
  | { kind: "changes"; dir: string; accept?: boolean };
/** The grant an operation needs: `sandbox:<session>:<this>`. */
export const grantFor = (operation: Operation): "execute" | "read" | "write" =>
  operation.kind === "execute" || operation.kind === "shell"
    ? "execute"
    : operation.kind === "write" || operation.kind === "checkout"
      ? "write"
      : "read";
export const deadlineMs = (operation: Operation): number =>
  operation.kind === "execute" || operation.kind === "shell"
    ? operation.timeoutMs
    : operation.kind === "checkout"
      ? LIMITS.checkoutTimeoutMs
      : LIMITS.timeoutMs;
export interface Result {
  stdout: string;
  stderr: string;
  exitCode: number;
}
export interface SandboxBinding {
  getByName(name: string): {
    run(id: string, operation: Operation): Promise<Result>;
    cancel(id: string): Promise<void>;
  };
}
const safeRelative = (value: unknown) =>
  typeof value === "string" &&
  value.length <= 256 &&
  /^[A-Za-z0-9_./-]+$/.test(value) &&
  !value.split("/").some((part) => !part || part === "." || part === "..");
/** A checkout directory is one path component directly under /workspace. */
const checkoutDir = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) && value !== "..";
export function validate(operation: Operation): void {
  if (
    !operation ||
    !["execute", "read", "write", "shell", "checkout", "changes"].includes(operation.kind)
  )
    throw new Error("sandbox_invalid_input");
  if (operation.kind === "execute" || operation.kind === "shell") {
    const code = operation.kind === "execute" ? operation.code : operation.command;
    const max = operation.kind === "execute" ? LIMITS.timeoutMs : LIMITS.shellTimeoutMs;
    if (
      typeof code !== "string" ||
      new TextEncoder().encode(code).length > LIMITS.inputBytes ||
      !Number.isInteger(operation.timeoutMs) ||
      operation.timeoutMs < 1 ||
      operation.timeoutMs > max ||
      (operation.kind === "shell" && operation.cwd !== undefined && !safeRelative(operation.cwd))
    )
      throw new Error("sandbox_invalid_input");
  } else if (operation.kind === "checkout") {
    if (!checkoutDir(operation.dir) || typeof operation.archive?.pipeThrough !== "function")
      throw new Error("sandbox_invalid_input");
  } else if (operation.kind === "changes") {
    if (!checkoutDir(operation.dir)) throw new Error("sandbox_invalid_input");
  } else {
    if (!safeRelative(operation.path)) throw new Error("sandbox_invalid_path");
    if (
      operation.kind === "write" &&
      (typeof operation.content !== "string" ||
        new TextEncoder().encode(operation.content).length > LIMITS.inputBytes)
    )
      throw new Error("sandbox_input_limit");
  }
}

// openat + O_NOFOLLOW on every component prevents generated symlinks escaping the workspace, including during races.
// Node has no dir_fd API, so each component is opened through /proc/self/fd/<dirfd>, which resolves like openat.
const fileProgram = `const fs=require('fs'),c=fs.constants,crypto=require('crypto');
const op=JSON.parse(process.argv[1]);
const dir=c.O_RDONLY|c.O_DIRECTORY|c.O_NOFOLLOW;
let fd=fs.openSync('/workspace',dir);
const parts=op.path.split('/');
for(const part of parts.slice(0,-1)){const next=fs.openSync('/proc/self/fd/'+fd+'/'+part,dir);fs.closeSync(fd);fd=next}
const at=name=>'/proc/self/fd/'+fd+'/'+name,name=parts[parts.length-1];
if(op.kind==='read'){
 const f=fs.openSync(at(name),c.O_RDONLY|c.O_NOFOLLOW|c.O_NONBLOCK);
 if(!fs.fstatSync(f).isFile())throw new Error('not a regular file');
 const buf=Buffer.alloc(65537),n=fs.readSync(f,buf,0,65537,0);
 if(n>65536)throw new Error('file too large');
 process.stdout.write(new TextDecoder('utf-8',{fatal:true}).decode(buf.subarray(0,n)));
}else{
 const tmp='.write-'+crypto.randomBytes(16).toString('hex');
 const f=fs.openSync(at(tmp),c.O_WRONLY|c.O_CREAT|c.O_EXCL|c.O_NOFOLLOW,0o600);
 try{fs.writeFileSync(f,op.content);fs.closeSync(f);fs.renameSync(at(tmp),at(name))}
 finally{try{fs.unlinkSync(at(tmp))}catch{}}
}
`;

// Tree helpers shared by the checkout and change scripts. Symlinks are never followed or listed.
const treeLib = String.raw`const fs=require('fs'),path=require('path'),crypto=require('crypto');
const name=process.argv[1],root='/workspace/'+name,baseFile='/workspace/.touka/'+name+'.json';
const SKIP=new Set(['.git','node_modules']);
function walk(dir,out){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(SKIP.has(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())walk(p,out);else if(e.isFile())out.push(p);if(out.length>50000)throw new Error('too many files')}return out}
const sha=f=>crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const state=()=>{const o={};for(const f of walk(root,[]))o[path.relative(root,f)]=sha(f);return o};
`;

// After extraction: remember what was checked out, and find the repository's own instructions and skills.
const finishCheckout =
  treeLib +
  String.raw`fs.mkdirSync('/workspace/.touka',{recursive:true});
const files=state();fs.writeFileSync(baseFile,JSON.stringify(files));
const read=(n,m)=>{try{return fs.readFileSync(path.join(root,n),'utf8').slice(0,m)}catch{return null}};
const instructions={};for(const n of ['AGENTS.md','CLAUDE.md']){const t=read(n,6000);if(t!==null)instructions[n]=t}
const skills=[];
try{for(const e of fs.readdirSync(path.join(root,'.agents/skills'),{withFileTypes:true})){if(!e.isDirectory())continue;
const rel='.agents/skills/'+e.name+'/SKILL.md',t=read(rel,4000);if(t===null)continue;
const fm=(/^---\n([\s\S]*?)\n---/.exec(t)||[])[1]||'';
const get=k=>{const r=new RegExp('^'+k+':[ \\t]*(.*)$','m').exec(fm);return r?r[1].replace(/^["'>|]+|["']+$/g,'').trim():''};
skills.push({name:get('name')||e.name,description:get('description').slice(0,300),path:rel})}}catch{}
console.log(JSON.stringify({files:Object.keys(files).length,instructions,skills}));`;
// What differs from the checkout; "accept" makes the current tree the new baseline (after publishing).
const changesProgram =
  treeLib +
  String.raw`let base;try{base=JSON.parse(fs.readFileSync(baseFile,'utf8'))}catch{console.error('no checkout');process.exit(2)}
const now=state(),added=[],modified=[],deleted=[];
for(const[f,h]of Object.entries(now)){if(!(f in base))added.push(f);else if(base[f]!==h)modified.push(f)}
for(const f of Object.keys(base))if(!(f in now))deleted.push(f);
if(process.argv[2]==='accept')fs.writeFileSync(baseFile,JSON.stringify(now));
const cap=a=>a.sort().slice(0,200);
console.log(JSON.stringify({added:cap(added),modified:cap(modified),deleted:cap(deleted),truncated:Math.max(added.length,modified.length,deleted.length)>200}));`;
const extract =
  'set -e; d="/workspace/$1"; rm -rf "$d"; mkdir -p "$d"; tar -xz --strip-components=1 -C "$d"';

/** Where the last good workspace snapshot lives. Without a store the workspace dies with the container. */
export interface SnapshotStore {
  load(): Promise<ContainerSnapshot | undefined>;
  save(snapshot: ContainerSnapshot): Promise<void>;
}

/** Native Cloudflare Container transport. No host processes or Worker environment are passed to Linux. */
export class SandboxRuntime {
  private active?: { id: string; controller: AbortController };
  constructor(
    private readonly container: Pick<Container, "running" | "start" | "exec" | "destroy"> &
      Partial<Pick<Container, "snapshotContainer">>,
    private readonly snapshots?: SnapshotStore,
  ) {}

  async cancel(id: string): Promise<void> {
    if (this.active?.id === id) this.active.controller.abort(new Error("sandbox_aborted"));
  }

  async run(id: string, operation: Operation): Promise<Result> {
    validate(operation);
    if (this.active) throw new Error("sandbox_busy");
    const controller = new AbortController();
    this.active = { id, controller };
    const { signal } = controller;
    const timer = setTimeout(
      () => controller.abort(new Error("sandbox_timeout")),
      deadlineMs(operation),
    );
    let process: ExecProcess | undefined;
    const stop = () => {
      process?.kill(9);
    };
    signal.addEventListener("abort", stop, { once: true });
    // Every command goes through here so the one in flight can be killed on abort or timeout.
    const spawn = async (
      argv: string[],
      options: { cwd?: string; stdin?: boolean } = {},
    ): Promise<ExecProcess> => {
      process = await this.container.exec(argv, {
        cwd: options.cwd ?? "/workspace",
        // PATH is added by the platform; HOME keeps package managers out of the read-only root.
        env: { HOME: "/tmp", CI: "1" },
        signal,
        ...(options.stdin ? { stdin: "pipe" as const } : {}),
        stdout: "pipe",
        stderr: "pipe",
      });
      signal.throwIfAborted();
      return process;
    };
    try {
      if (!this.container.running) {
        // A destroyed container (timeout, abort, overflow) restarts from the last good snapshot.
        const containerSnapshot = await this.snapshots?.load();
        this.container.start({
          ...(containerSnapshot ? { containerSnapshot } : { image: SANDBOX_IMAGE }),
          entrypoint: ["sleep", "infinity"],
          enableInternet: false,
          env: {},
        });
        // Also the readiness probe: it only succeeds once the container accepts commands.
        const mkdir = await this.container.exec(["mkdir", "-p", "/workspace"], { signal });
        if ((await mkdir.exitCode) !== 0) throw new Error("sandbox_transport_error");
      }
      signal.throwIfAborted();
      let bytes = 0;
      // A script's output past the limit is a failure; a shell's is cut to its head and tail, since
      // a test run that prints a lot is normal and its end is what matters.
      const consume = async (stream: ReadableStream | null, cut: boolean): Promise<string> => {
        if (!stream) throw new Error("sandbox_transport_error");
        const reader = stream.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: !cut });
        const head: string[] = [];
        let headBytes = 0;
        let tail = "";
        let dropped = 0;
        let text = "";
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) {
              if (!cut) return text + decoder.decode();
              const rest = tail + decoder.decode();
              const note = dropped ? `\n[... ${dropped} characters omitted ...]\n` : "";
              return head.join("") + note + rest;
            }
            if (!cut) {
              bytes += chunk.value.byteLength;
              if (bytes > LIMITS.outputBytes) {
                controller.abort(new Error("sandbox_output_limit"));
                throw new Error("sandbox_output_limit");
              }
              text += decoder.decode(chunk.value, { stream: true });
              continue;
            }
            let piece = decoder.decode(chunk.value, { stream: true });
            if (headBytes < 16_000) {
              // Fill the head exactly; whatever does not fit already counts as tail.
              const room = piece.slice(0, 16_000 - headBytes);
              head.push(room);
              headBytes += room.length;
              piece = piece.slice(room.length);
            }
            tail += piece;
            if (tail.length > 32_000) {
              dropped += tail.length - 32_000;
              tail = tail.slice(-32_000);
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      };
      const finish = async (child: ExecProcess, cut: boolean) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          consume(child.stdout, cut),
          consume(child.stderr, cut),
          child.exitCode,
        ]);
        signal.throwIfAborted();
        return { stdout, stderr, exitCode };
      };
      let result: Result;
      if (operation.kind === "checkout") {
        // Why not clone inside: the container has no network and holds no credential. The Worker
        // fetches the archive and streams it in; the bytes are counted, not trusted.
        const extractor = await spawn(["bash", "-c", extract, "--", operation.dir], {
          stdin: true,
        });
        const done = finish(extractor, false);
        let total = 0;
        const counted = new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, out) {
            total += chunk.byteLength;
            if (total > LIMITS.archiveBytes) out.error(new Error("sandbox_input_limit"));
            else out.enqueue(chunk);
          },
        });
        try {
          await operation.archive.pipeThrough(counted).pipeTo(extractor.stdin!, { signal });
        } catch (error) {
          if (error instanceof Error && error.message === "sandbox_input_limit") throw error;
          // tar stopped listening because it rejected the stream: its verdict, not a transport fault.
          if ((await done).exitCode !== 0) throw new Error("sandbox_checkout_failed");
          throw error;
        }
        if ((await done).exitCode !== 0) throw new Error("sandbox_checkout_failed");
        const summary = await finish(
          await spawn(["node", "-e", finishCheckout, operation.dir]),
          false,
        );
        if (summary.exitCode !== 0) throw new Error("sandbox_checkout_failed");
        result = summary;
      } else if (operation.kind === "changes") {
        result = await finish(
          await spawn([
            "node",
            "-e",
            changesProgram,
            operation.dir,
            ...(operation.accept ? ["accept"] : []),
          ]),
          false,
        );
        if (result.exitCode !== 0) throw new Error("sandbox_not_checked_out");
      } else if (operation.kind === "shell") {
        result = await finish(
          await spawn(["bash", "-c", operation.command], {
            cwd: operation.cwd ? `/workspace/${operation.cwd}` : "/workspace",
          }),
          true,
        );
      } else {
        const argv =
          operation.kind === "execute"
            ? ["node", "-e", operation.code]
            : ["node", "-e", fileProgram, JSON.stringify(operation)];
        result = await finish(await spawn(argv), false);
        if (operation.kind !== "execute" && result.exitCode !== 0)
          throw new Error("sandbox_file_error");
      }
      if (operation.kind !== "read" && operation.kind !== "changes") await this.snapshot();
      return result;
    } catch (error) {
      process?.kill(9);
      if (signal.aborted) throw signal.reason;
      // Transport errors may contain credential-bearing infrastructure diagnostics.
      if (
        error instanceof Error &&
        [
          "sandbox_output_limit",
          "sandbox_file_error",
          "sandbox_input_limit",
          "sandbox_checkout_failed",
          "sandbox_not_checked_out",
        ].includes(error.message)
      )
        throw error;
      throw new Error("sandbox_transport_error");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      // Destroy on cancellation/failure to terminate descendants, not only the direct process.
      try {
        if (signal.aborted) await this.container.destroy();
      } finally {
        this.active = undefined;
      }
    }
  }

  /** Best-effort: a failed snapshot keeps the previous one and must not fail an operation that already ran. */
  private async snapshot(): Promise<void> {
    if (!this.snapshots || !this.container.snapshotContainer) return;
    try {
      await this.snapshots.save(await this.container.snapshotContainer({ name: "workspace" }));
    } catch {
      // ponytail: silent; surface it as a result field if lost workspaces ever matter.
    }
  }
}
