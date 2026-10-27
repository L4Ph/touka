export const LIMITS = { inputBytes: 32_768, outputBytes: 65_536, timeoutMs: 10_000 } as const;
export type Operation =
  | { kind: "execute"; language: "python" | "javascript"; code: string; timeoutMs: number }
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string };
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
export function validate(operation: Operation): void {
  if (!operation || !["execute", "read", "write"].includes(operation.kind))
    throw new Error("sandbox_invalid_input");
  if (operation.kind === "execute") {
    if (
      !["python", "javascript"].includes(operation.language) ||
      typeof operation.code !== "string" ||
      new TextEncoder().encode(operation.code).length > LIMITS.inputBytes ||
      !Number.isInteger(operation.timeoutMs) ||
      operation.timeoutMs < 1 ||
      operation.timeoutMs > LIMITS.timeoutMs
    )
      throw new Error("sandbox_invalid_input");
  } else {
    if (
      typeof operation.path !== "string" ||
      operation.path.length > 256 ||
      !/^[A-Za-z0-9_.\/-]+$/.test(operation.path) ||
      operation.path.split("/").some((part) => !part || part === "." || part === "..")
    )
      throw new Error("sandbox_invalid_path");
    if (
      operation.kind === "write" &&
      (typeof operation.content !== "string" ||
        new TextEncoder().encode(operation.content).length > LIMITS.inputBytes)
    )
      throw new Error("sandbox_input_limit");
  }
}

// openat + O_NOFOLLOW on every component prevents generated symlinks escaping the workspace, including during races.
const fileProgram = `import os,sys,json,stat,secrets
op=json.loads(sys.argv[1])
fd=os.open('/workspace',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
parts=op['path'].split('/')
for part in parts[:-1]:
 nextfd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
 os.close(fd)
 fd=nextfd
name=parts[-1]
if op['kind']=='read':
 f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 if not stat.S_ISREG(os.fstat(f).st_mode): raise ValueError('not a regular file')
 data=os.read(f,65537)
 if len(data)>65536: raise ValueError('file too large')
 sys.stdout.write(data.decode('utf-8'))
else:
 tmp='.write-'+secrets.token_hex(16)
 f=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
 try:
  with os.fdopen(f,'wb') as out: out.write(op['content'].encode('utf-8'))
  os.rename(tmp,name,src_dir_fd=fd,dst_dir_fd=fd)
 finally:
  try: os.unlink(tmp,dir_fd=fd)
  except FileNotFoundError: pass
os.close(fd)
`;

/** Native Cloudflare Container transport. No host processes or Worker environment are passed to Linux. */
export class SandboxRuntime {
  private active?: { id: string; controller: AbortController };
  constructor(
    private readonly container: Pick<
      Container,
      "running" | "images" | "start" | "exec" | "destroy"
    >,
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
      operation.kind === "execute" ? operation.timeoutMs : LIMITS.timeoutMs,
    );
    let process: ExecProcess | undefined;
    const stop = () => {
      process?.kill(9);
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      if (!this.container.running) {
        this.container.start({
          image: this.container.images.sandbox,
          entrypoint: ["sleep", "infinity"],
          enableInternet: false,
          env: {},
        });
        const { Files } = await import("@cloudflare/sandbox");
        await new Files(this.container).mkdir("/workspace", { recursive: true, signal });
      }
      signal.throwIfAborted();
      const argv =
        operation.kind === "execute"
          ? operation.language === "python"
            ? ["python3", "-I", "-c", operation.code]
            : ["node", "-e", operation.code]
          : ["python3", "-I", "-c", fileProgram, JSON.stringify(operation)];
      process = await this.container.exec(argv, {
        cwd: "/workspace",
        env: {},
        signal,
        stdout: "pipe",
        stderr: "pipe",
      });
      signal.throwIfAborted();
      let bytes = 0;
      const consume = async (stream: ReadableStream | null): Promise<string> => {
        if (!stream) throw new Error("sandbox_transport_error");
        const reader = stream.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let text = "";
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return text + decoder.decode();
            bytes += chunk.value.byteLength;
            if (bytes > LIMITS.outputBytes) {
              controller.abort(new Error("sandbox_output_limit"));
              throw new Error("sandbox_output_limit");
            }
            text += decoder.decode(chunk.value, { stream: true });
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      };
      const [stdout, stderr, exitCode] = await Promise.all([
        consume(process.stdout),
        consume(process.stderr),
        process.exitCode,
      ]);
      signal.throwIfAborted();
      if (operation.kind !== "execute" && exitCode !== 0) throw new Error("sandbox_file_error");
      return { stdout, stderr, exitCode };
    } catch (error) {
      process?.kill(9);
      if (signal.aborted) throw signal.reason;
      // Transport errors may contain credential-bearing infrastructure diagnostics.
      if (
        error instanceof Error &&
        ["sandbox_output_limit", "sandbox_file_error"].includes(error.message)
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
}
