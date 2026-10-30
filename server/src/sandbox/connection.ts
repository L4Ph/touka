import { RemoteError, type Connection, type RemoteInfo, type Reply } from "@earendil-works/pi-env";
import type { RequestOptions } from "@earendil-works/pi-env";

// The pi-env wire protocol (see @earendil-works/pi-env docs/protocol.md), spoken over a pair of web
// streams. Why not pi-env's own Connection: it starts the daemon with node:child_process, which a
// Worker does not have. The framing below is the protocol, not a fork of the tools built on it.
const REQUEST = 1;
const RESULT = 2;
const ERROR = 3;
const EVENT = 4;
const CANCEL = 5;
const PING = 6;
const MAX_FRAME = 16 * 1024 * 1024;
const PING_INTERVAL_MS = 5000;
const SILENCE_LIMIT_MS = 30_000;
const START_TIMEOUT_MS = 60_000;

export interface Duplex {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
}

type Json = Record<string, unknown>;

const lost = (message: string) => new RemoteError({ code: "unknown", message, lost: true });

function frame(type: number, id: number, json: Json, payload = new Uint8Array(0)): Uint8Array {
  const body = new TextEncoder().encode(
    JSON.stringify(json, (_key, value) =>
      typeof value === "string"
        ? (value as string & { toWellFormed(): string }).toWellFormed()
        : value,
    ),
  );
  const out = new Uint8Array(13 + body.length + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, 9 + body.length + payload.length);
  view.setUint8(4, type);
  view.setUint32(5, id);
  view.setUint32(9, body.length);
  out.set(body, 13);
  out.set(payload, 13 + body.length);
  return out;
}

interface Pending {
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  onEvent?: (json: Json, payload: Uint8Array) => void;
}

class Session {
  readonly pending = new Map<number, Pending>();
  live = true;
  lastSeen = Date.now();
  timer?: ReturnType<typeof setInterval>;
  private received = new Uint8Array(0);
  private synced = false;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  constructor(
    readonly id: number,
    private readonly duplex: Duplex,
    private readonly token: string,
    private readonly onFrame: (type: number, id: number, json: Json, payload: Uint8Array) => void,
    readonly onClose: (error: Error) => void,
  ) {
    this.writer = duplex.stdin.getWriter();
    void this.read();
  }

  write(data: Uint8Array): void {
    if (this.live)
      this.writer.write(data).catch(() => this.onClose(lost("pi-env connection lost")));
  }

  close(): void {
    this.live = false;
    clearInterval(this.timer);
    this.writer.close().catch(() => {});
    this.duplex.stdout.cancel().catch(() => {});
  }

  private async read(): Promise<void> {
    const reader = this.duplex.stdout.getReader();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        this.lastSeen = Date.now();
        this.append(chunk.value);
      }
    } catch {
      // The stream failed: the same outcome as it ending.
    }
    this.onClose(lost("pi-env connection lost"));
  }

  private append(chunk: Uint8Array): void {
    const joined = new Uint8Array(this.received.length + chunk.length);
    joined.set(this.received);
    joined.set(chunk, this.received.length);
    this.received = joined;
    if (!this.synced) {
      // Shell startup files may print before the daemon runs; skip everything before its sync line.
      const marker = new TextEncoder().encode(`PI-ENV ${this.token}\n`);
      const at = indexOf(this.received, marker);
      if (at === -1) {
        if (this.received.length > 1024 * 1024) this.received = this.received.slice(-marker.length);
        return;
      }
      this.received = this.received.slice(at + marker.length);
      this.synced = true;
    }
    while (this.live && this.received.length >= 4) {
      const view = new DataView(this.received.buffer, this.received.byteOffset);
      const length = view.getUint32(0);
      if (length < 9 || length > MAX_FRAME) return this.onClose(lost("Corrupt frame from pi-env"));
      if (this.received.length < 4 + length) return;
      const body = this.received.subarray(4, 4 + length);
      const type = body[0]!;
      const id = new DataView(body.buffer, body.byteOffset).getUint32(1);
      const jsonLength = new DataView(body.buffer, body.byteOffset).getUint32(5);
      let json: Json;
      try {
        if (9 + jsonLength > length) throw new Error("JSON length out of range");
        const parsed: unknown = JSON.parse(
          new TextDecoder().decode(body.subarray(9, 9 + jsonLength)),
        );
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
          throw new Error("not an object");
        json = parsed as Json;
      } catch {
        return this.onClose(lost("Corrupt frame from pi-env"));
      }
      const payload = new Uint8Array(body.subarray(9 + jsonLength));
      this.received = this.received.slice(4 + length);
      this.onFrame(type, id, json, payload);
    }
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * The surface of pi-env's `Connection` that `RemoteExecutionEnv` uses, over a daemon reached through
 * `open`: started lazily on the first request and started again after it is lost.
 */
export class ContainerConnection {
  private session?: Session;
  private ready?: Promise<{ info: RemoteInfo; session: Session }>;
  private sessions = 0;
  private nextId = 1;
  private closed = false;

  constructor(private readonly open: (token: string) => Promise<Duplex>) {}

  async info(): Promise<RemoteInfo> {
    return (await this.connect()).info;
  }

  async request(op: string, json: Json, options: RequestOptions = {}): Promise<Reply> {
    if (options.session !== undefined) {
      const current = this.session;
      if (!current || current.id !== options.session || !current.live)
        throw lost("pi-env connection lost");
      return this.send(current, op, json, options);
    }
    return this.send((await this.connect()).session, op, json, options);
  }

  close(): void {
    this.closed = true;
    if (this.session)
      this.teardown(
        this.session,
        new RemoteError({ code: "unknown", message: "Connection closed" }),
      );
  }

  kill(id: number, session: number): void {
    const current = this.session;
    if (current?.id === session && current.live) current.write(frame(CANCEL, id, { mode: "kill" }));
  }

  private connect() {
    if (this.closed)
      return Promise.reject(new RemoteError({ code: "unknown", message: "Connection closed" }));
    if (!this.ready) {
      const ready = this.start();
      this.ready = ready;
      // A failed start is not remembered: the next request tries again.
      ready.catch(() => {
        if (this.ready === ready) this.ready = undefined;
      });
    }
    return this.ready;
  }

  private send(session: Session, op: string, json: Json, options: RequestOptions): Promise<Reply> {
    if (!session.live) return Promise.reject(lost("pi-env connection lost"));
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const onAbort = () => session.write(frame(CANCEL, id, {}));
      const done = () => options.signal?.removeEventListener("abort", onAbort);
      session.pending.set(id, {
        resolve: (reply) => (done(), resolve(reply)),
        reject: (error) => (done(), reject(error)),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      options.onStart?.(id, session.id);
      session.write(
        frame(REQUEST, id, { ...json, op }, options.payload as Uint8Array<ArrayBuffer> | undefined),
      );
      if (options.signal?.aborted) onAbort();
    });
  }

  private async start(): Promise<{ info: RemoteInfo; session: Session }> {
    const token = [...crypto.getRandomValues(new Uint8Array(16))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    let duplex: Duplex;
    try {
      duplex = await this.open(token);
    } catch (error) {
      throw new RemoteError({
        code: "spawn_error",
        message: error instanceof Error ? error.message : String(error),
        lost: true,
      });
    }
    const session: Session = new Session(
      ++this.sessions,
      duplex,
      token,
      (type, id, json, payload) => this.dispatch(session, type, id, json, payload),
      (error) => this.teardown(session, error),
    );
    this.session = session;
    session.timer = setInterval(() => {
      session.write(frame(PING, 0, {}));
      if (Date.now() - session.lastSeen > SILENCE_LIMIT_MS)
        this.teardown(session, lost("pi-env connection timed out"));
    }, PING_INTERVAL_MS);
    let startTimer: ReturnType<typeof setTimeout> | undefined;
    const failed = new Promise<never>((_resolve, reject) => {
      startTimer = setTimeout(
        () => reject(lost(`pi-env did not answer within ${START_TIMEOUT_MS / 1000} s`)),
        START_TIMEOUT_MS,
      );
    });
    failed.catch(() => {});
    try {
      const { json } = await Promise.race([
        this.send(session, "hello", { protocol: 1 }, {}),
        failed,
      ]);
      if (json.protocol !== 1) throw lost(`Unsupported protocol ${json.protocol}`);
      return { info: json as unknown as RemoteInfo, session };
    } catch (error) {
      this.teardown(session, error instanceof Error ? error : lost(String(error)));
      throw error;
    } finally {
      clearTimeout(startTimer);
    }
  }

  private teardown(session: Session, error: Error): void {
    if (!session.live) return;
    session.close();
    if (this.session === session) {
      this.session = undefined;
      this.ready = undefined;
    }
    const pending = [...session.pending.values()];
    session.pending.clear();
    for (const request of pending) request.reject(error);
  }

  private dispatch(session: Session, type: number, id: number, json: Json, payload: Uint8Array) {
    const pending = session.pending.get(id);
    if (type === EVENT) return pending?.onEvent?.(json, payload);
    if (type !== RESULT && type !== ERROR) return;
    if (!pending) return;
    session.pending.delete(id);
    if (type === RESULT) pending.resolve({ json, payload, session: session.id });
    else pending.reject(new RemoteError(json));
  }
}

/** `RemoteExecutionEnv` is typed against pi-env's own class; the two share this surface at runtime. */
export const asConnection = (connection: ContainerConnection): Connection =>
  connection as unknown as Connection;

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  // A daemon that answers `hello` and echoes the payload of `echo`, speaking the real framing.
  function fakeDaemon(): (token: string) => Promise<Duplex> {
    return async (token) => {
      const input = new TransformStream<Uint8Array, Uint8Array>();
      let output!: ReadableStreamDefaultController<Uint8Array>;
      const stdout = new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller;
          controller.enqueue(new TextEncoder().encode(`noise\nPI-ENV ${token}\n`));
        },
      });
      void (async () => {
        const reader = input.readable.getReader();
        let buffer = new Uint8Array(0);
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return;
          buffer = Uint8Array.from([...buffer, ...chunk.value]);
          while (buffer.length >= 4) {
            const length = new DataView(buffer.buffer).getUint32(0);
            if (buffer.length < 4 + length) break;
            const body = buffer.subarray(4, 4 + length);
            const type = body[0];
            const id = new DataView(body.buffer, body.byteOffset).getUint32(1);
            const jsonLength = new DataView(body.buffer, body.byteOffset).getUint32(5);
            const json = JSON.parse(new TextDecoder().decode(body.subarray(9, 9 + jsonLength)));
            const payload = body.slice(9 + jsonLength);
            buffer = buffer.slice(4 + length);
            if (type !== REQUEST) continue;
            if (json.op === "hello")
              output.enqueue(frame(RESULT, id, { protocol: 1, os: "linux", arch: "x86_64" }));
            else if (json.op === "echo") output.enqueue(frame(RESULT, id, { ok: true }, payload));
            else output.enqueue(frame(ERROR, id, { code: "ENOENT", message: "no", path: "/x" }));
          }
        }
      })();
      return { stdin: input.writable, stdout };
    };
  }

  test("a request round-trips its payload, skipping shell noise before the sync line", async () => {
    const connection = new ContainerConnection(fakeDaemon());
    const reply = await connection.request("echo", {}, { payload: new Uint8Array([1, 2, 3]) });
    expect([...reply.payload]).toEqual([1, 2, 3]);
    expect((await connection.info()).os).toBe("linux");
    connection.close();
  });

  test("a daemon error surfaces with its code and path", async () => {
    const connection = new ContainerConnection(fakeDaemon());
    await expect(connection.request("missing", {})).rejects.toMatchObject({
      code: "ENOENT",
      path: "/x",
    });
    connection.close();
  });

  test("a lost connection fails the request and the next one starts a new daemon", async () => {
    let opened = 0;
    const open = fakeDaemon();
    const connection = new ContainerConnection(async (token) => {
      opened++;
      const duplex = await open(token);
      return opened === 1
        ? { stdin: duplex.stdin, stdout: new ReadableStream({ start: (c) => c.close() }) }
        : duplex;
    });
    await expect(connection.request("echo", {})).rejects.toMatchObject({ fields: { lost: true } });
    expect(
      (await connection.request("echo", {}, { payload: new Uint8Array([9]) })).payload[0],
    ).toBe(9);
    expect(opened).toBe(2);
    connection.close();
  });
}
