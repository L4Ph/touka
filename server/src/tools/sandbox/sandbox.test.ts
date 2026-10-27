import { test } from "node:test";
import assert from "node:assert/strict";
import { create } from "./index";
import {
  LIMITS,
  SandboxRuntime,
  type SandboxBinding,
  type Operation,
  type Result,
} from "./runtime";

function tools(
  binding?: SandboxBinding,
  sessionId = "one",
  sessions = [sessionId],
  resources = ["read", "write", "execute"].map((r) => `sandbox:${sessionId}:${r}`),
) {
  return create({
    env: Object.assign(Object.create(null), {
      SANDBOX: binding,
      MODEL_API_KEY: "must-not-be-passed",
    }),
    sessionId,
    principal: { id: "member", sessions, resources },
  }).tools!;
}
async function call(
  registered: ReturnType<typeof tools>,
  name: string,
  input: object,
  signal?: AbortSignal,
) {
  const tool = registered.find((tool) => tool.name === `sandbox_${name}`);
  assert.ok(tool, `missing ${name}`);
  return Reflect.apply(tool.execute, tool, [input, undefined, { abortSignal: signal }]);
}
const ok: Result = { stdout: "hello \u4e16\u754c", stderr: "", exitCode: 0 };

test("missing configuration and unauthorized sessions/resources fail closed before remote execution", async () => {
  await assert.rejects(call(tools(), "read_file", { path: "a" }), /sandbox_unconfigured/);
  const binding: SandboxBinding = {
    getByName() {
      throw new Error("must not reach remote");
    },
  };
  await assert.rejects(
    call(tools(binding, "two", ["one"]), "read_file", { path: "a" }),
    /sandbox_forbidden/,
  );
  await assert.rejects(
    call(tools(binding, "one", ["one"], ["sandbox:one:read"]), "execute", {
      language: "python",
      code: "1",
      timeoutMs: 20,
    }),
    /sandbox_forbidden/,
  );
});

test("traversal, encoded paths, absolute paths and oversized input never reach the binding", async () => {
  const binding: SandboxBinding = {
    getByName() {
      throw new Error("must not reach remote");
    },
  };
  const registered = tools(binding);
  for (const path of [
    "../two/private",
    "/etc/passwd",
    "a/../../b",
    "a//b",
    "a/./b",
    "%2e%2e/x",
    "a\\b",
    "x\0",
  ]) {
    await assert.rejects(call(registered, "read_file", { path }), /sandbox_invalid_path/);
  }
  await assert.rejects(
    call(registered, "write_file", { path: "a", content: "\u754c".repeat(LIMITS.inputBytes) }),
    /sandbox_input_limit/,
  );
  await assert.rejects(
    call(registered, "execute", { language: "python", code: "", timeoutMs: LIMITS.timeoutMs + 1 }),
    /sandbox_invalid_input/,
  );
});

test("file operations use session-derived isolated namespaces and carry only the requested operation", async () => {
  const requests: { name: string; operation: Operation }[] = [];
  const binding: SandboxBinding = {
    getByName(name) {
      return {
        async run(_id, operation) {
          requests.push({ name, operation });
          return ok;
        },
        async cancel() {},
      };
    },
  };
  const first = tools(binding);
  const read = await call(first, "read_file", { path: "report.txt" });
  assert.equal(JSON.parse(read.output[0].text).stdout, "hello \u4e16\u754c");
  await call(first, "write_file", { path: "report.txt", content: "updated" });
  await call(tools(binding, "two"), "read_file", { path: "report.txt" });
  assert.match(requests[0].name, /^sandbox-[a-f0-9]{64}$/);
  assert.equal(requests[0].name, requests[1].name);
  assert.notEqual(requests[0].name, requests[2].name);
  assert.deepEqual(requests[1].operation, {
    kind: "write",
    path: "report.txt",
    content: "updated",
  });
  assert.equal(first.find((tool) => tool.name === "sandbox_execute")?.replay, "unsafe");
  assert.equal(first.find((tool) => tool.name === "sandbox_read_file")?.replay, "safe");
  assert.equal(first.find((tool) => tool.name === "sandbox_write_file")?.replay, "safe");
});

test("tool abort invokes remote cancellation, including a pre-aborted call", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cancelled = "";
  let requestId = "";
  const binding: SandboxBinding = {
    getByName() {
      return {
        run(id) {
          requestId = id;
          started();
          return new Promise<Result>(() => {});
        },
        async cancel(id) {
          cancelled = id;
        },
      };
    },
  };
  const controller = new AbortController();
  const pending = call(
    tools(binding),
    "execute",
    { language: "python", code: "while True: pass", timeoutMs: 100 },
    controller.signal,
  );
  await ready;
  controller.abort();
  await assert.rejects(pending, /sandbox_aborted/);
  assert.ok(requestId);
  assert.equal(cancelled, requestId);
  await assert.rejects(
    call(tools(binding), "read_file", { path: "a" }, controller.signal),
    /sandbox_aborted/,
  );
});

test("tool reports nonzero exits, sanitizes transport failures and rejects oversized remote output", async () => {
  let response = { ...ok, exitCode: 7, stderr: "execution failed" };
  let fail = false;
  const binding: SandboxBinding = {
    getByName() {
      return {
        async run() {
          if (fail) throw new Error("provider secret diagnostic");
          return response;
        },
        async cancel() {},
      };
    },
  };
  const registered = tools(binding);
  const result = await call(registered, "execute", {
    language: "javascript",
    code: "process.exit(7)",
    timeoutMs: 10,
  });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.output[0].text).exitCode, 7);
  response = { ...ok, stdout: "a".repeat(LIMITS.outputBytes + 1) };
  await assert.rejects(call(registered, "read_file", { path: "a" }), /sandbox_output_limit/);
  fail = true;
  await assert.rejects(call(registered, "read_file", { path: "a" }), {
    message: "sandbox_transport_error",
  });
});

// Only the native Cloudflare execution boundary is doubled; streams and tool/runtime policy are real.
function container(exec: Container["exec"]) {
  let destroyed = 0;
  return {
    boundary: {
      running: true,
      images: { sandbox: "test-image" },
      start() {
        throw new Error("already running");
      },
      exec,
      async destroy() {
        destroyed++;
      },
    },
    destroyed: () => destroyed,
  };
}
function processOutput(stdout: string, stderr = "", exitCode = 0): ExecProcess {
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  return {
    stdin: null,
    stdout: stream(stdout),
    stderr: stream(stderr),
    pid: 1,
    isPty: false,
    exitCode: Promise.resolve(exitCode),
    kill() {},
    resize() {},
    async output() {
      throw new Error("unbounded output must not be used");
    },
  };
}

test("native runtime bounds combined stdout/stderr by bytes and destroys an output-flooding container", async () => {
  const fixture = container(async () => processOutput("a".repeat(40_000), "\u754c".repeat(10_000)));
  const runtime = new SandboxRuntime(fixture.boundary);
  await assert.rejects(
    runtime.run("flood", { kind: "execute", language: "python", code: "print(1)", timeoutMs: 100 }),
    /sandbox_output_limit/,
  );
  assert.equal(fixture.destroyed(), 1);
});

test("native runtime passes cancellation to transport and destroys on timeout or explicit stop", async () => {
  let started!: () => void;
  let observed: AbortSignal | undefined;
  const fixture = container(async (_argv, options) => {
    observed = options?.signal;
    started();
    return new Promise<ExecProcess>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
        once: true,
      });
    });
  });
  const runtime = new SandboxRuntime(fixture.boundary);
  let ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const timed = runtime.run("timeout", {
    kind: "execute",
    language: "python",
    code: "",
    timeoutMs: 5,
  });
  await ready;
  await assert.rejects(timed, /sandbox_timeout/);
  assert.equal(observed?.aborted, true);
  ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stopped = runtime.run("stop", {
    kind: "execute",
    language: "python",
    code: "",
    timeoutMs: 1000,
  });
  await ready;
  await assert.rejects(runtime.run("busy", { kind: "read", path: "a" }), /sandbox_busy/);
  await runtime.cancel("different-id");
  assert.equal(observed?.aborted, false);
  await runtime.cancel("stop");
  await assert.rejects(stopped, /sandbox_aborted/);
  assert.equal(fixture.destroyed(), 2);
});

test("native execution uses argv without shell or app secrets and reports file/transport failures", async () => {
  let failure = false;
  let argv: string[] = [];
  let options: ContainerExecOptions | undefined;
  const fixture = container(async (command, config) => {
    argv = command;
    options = config;
    if (failure) throw new Error("infrastructure secret");
    return processOutput("done", "", 4);
  });
  const runtime = new SandboxRuntime(fixture.boundary);
  const result = await runtime.run("code", {
    kind: "execute",
    language: "python",
    code: 'print("hi")',
    timeoutMs: 100,
  });
  assert.equal(result.exitCode, 4);
  assert.deepEqual(argv, ["python3", "-I", "-c", 'print("hi")']);
  assert.deepEqual(options?.env, {});
  assert.equal(options?.cwd, "/workspace");
  await assert.rejects(runtime.run("file", { kind: "read", path: "a" }), /sandbox_file_error/);
  failure = true;
  await assert.rejects(runtime.run("transport", { kind: "read", path: "a" }), {
    message: "sandbox_transport_error",
  });
});
