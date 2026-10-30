import type nodeAssert from "node:assert/strict";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolContext } from "../../tools";
import { githubConnector } from "@remote-agent/connector-github";
import {
  LIMITS,
  deadlineMs,
  grantFor,
  validate,
  type Operation,
  type Result,
  type SandboxBinding,
} from "./runtime";

export function create(context: ToolContext) {
  /** `sandbox:*:<grant>` grants the conversation its own sandbox; the model never picks the target. */
  function permit(grant: "execute" | "read" | "write") {
    if (
      !context.principal.sessions.includes(context.sessionId) ||
      !["*", context.sessionId].some((target) =>
        context.principal.resources.includes(`sandbox:${target}:${grant}`),
      )
    )
      throw new Error("sandbox_forbidden");
  }
  async function run(operation: Operation, signal?: AbortSignal): Promise<Result> {
    validate(operation);
    permit(grantFor(operation));
    const binding = (context.env as unknown as { SANDBOX_CONTAINER?: SandboxBinding })
      .SANDBOX_CONTAINER;
    if (!binding) throw new Error("sandbox_unconfigured");
    if (signal?.aborted) throw new Error("sandbox_aborted");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(context.sessionId));
    const name =
      "sandbox-" +
      Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
    let sandbox: ReturnType<SandboxBinding["getByName"]>;
    try {
      sandbox = binding.getByName(name);
    } catch {
      throw new Error("sandbox_transport_error");
    }
    const id = crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: () => void = () => {};
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => {
        void sandbox.cancel(id).catch(() => {});
        reject(new Error("sandbox_aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () => {
          void sandbox.cancel(id).catch(() => {});
          reject(new Error("sandbox_timeout"));
        },
        deadlineMs(operation) + 1000,
      );
    });
    try {
      if (signal?.aborted) abort();
      const result = await Promise.race([sandbox.run(id, operation), interrupted]);
      if (
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        !Number.isInteger(result.exitCode) ||
        new TextEncoder().encode(result.stdout + result.stderr).length > LIMITS.outputBytes
      )
        throw new Error("sandbox_output_limit");
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      throw new Error(
        /^sandbox_(timeout|aborted|output_limit|file_error|busy|transport_error|unconfigured|input_limit|checkout_failed|not_checked_out)$/.test(
          message,
        )
          ? message
          : "sandbox_transport_error",
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  /** A tool answer: the result as JSON, flagged as an error when the command failed. */
  async function invoke(operation: Operation, signal?: AbortSignal) {
    const result = await run(operation, signal);
    return {
      output: [{ type: "text" as const, text: JSON.stringify(result) }],
      isError: result.exitCode !== 0,
    };
  }
  const github = githubConnector(context.env);
  const answer = (value: unknown) => ({
    output: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  /** The directory a repository is checked out into: its name, one component under /workspace. */
  const dirOf = (repo: string) => repo.split("/")[1] ?? "";
  const path = Type.String({ minLength: 1, maxLength: 256 });
  return defineExtension({
    name: "sandbox",
    tools: [
      defineTool({
        name: "sandbox_execute",
        description:
          "Run JavaScript (Node.js) in this session’s isolated offline Linux container. Never replay automatically. No host shell or deployment.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            code: Type.String({ maxLength: LIMITS.inputBytes }),
            timeoutMs: Type.Integer({ minimum: 1, maximum: LIMITS.timeoutMs }),
          },
          { additionalProperties: false },
        ),
        execute: (args, _api, execution) =>
          invoke(
            {
              kind: "execute",
              code: args.code,
              timeoutMs: args.timeoutMs,
            },
            execution?.abortSignal,
          ),
      }),
      defineTool({
        name: "sandbox_checkout",
        description:
          "Check a repository out into this session's workspace at /workspace/<repo name>, at a branch, tag or commit (default: the default branch). Returns the commit sha (start branches from it), the file count, the repository's own instructions (AGENTS.md, CLAUDE.md) and its skills under .agents/skills (read SKILL.md with sandbox_read_file before doing what a skill covers). The container is offline: dependencies cannot be installed, and nothing in it holds a credential. Replaces an earlier checkout of the same repository.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            repo: Type.String({ minLength: 3, maxLength: 140 }),
            ref: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
        execute: async (args, _api, execution) => {
          // Both sides must allow it, and the sandbox side first: GitHub read for the archive, a
          // writable sandbox for the files. Nothing is downloaded for a conversation that may not use it.
          permit("write");
          const fetched = await github.archive(args, context.principal.resources);
          const result = await run(
            { kind: "checkout", dir: dirOf(args.repo), archive: fetched.body },
            execution?.abortSignal,
          );
          return answer({
            repo: args.repo,
            dir: dirOf(args.repo),
            sha: fetched.sha,
            ...JSON.parse(result.stdout),
          });
        },
      }),
      defineTool({
        name: "sandbox_shell",
        description:
          "Run a shell command (bash -c) in this session's offline container, from /workspace or a directory under it (cwd, for example the checkout). Output beyond about 48,000 characters is cut to its beginning and end. Default timeout 2 minutes, at most 10. Use it to search, build and run tests that need no network. Never replayed automatically.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            command: Type.String({ minLength: 1, maxLength: LIMITS.inputBytes }),
            timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.shellTimeoutMs })),
            cwd: Type.Optional(path),
          },
          { additionalProperties: false },
        ),
        execute: (args, _api, execution) =>
          invoke(
            {
              kind: "shell",
              command: args.command,
              timeoutMs: args.timeoutMs ?? 120_000,
              cwd: args.cwd,
            },
            execution?.abortSignal,
          ),
      }),
      defineTool({
        name: "sandbox_publish",
        description:
          "Commit what differs from the checkout (added, changed and deleted files) to an existing branch of the repository in one commit, then treat the result as the new baseline. Create the branch first from the checkout's sha with github_create_branch, and open the pull request afterwards with github_open_pull_request. Text files up to 64 KiB with plain paths are published; any others are listed as skipped and the baseline is left unchanged. Files are written as regular non-executable files.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            repo: Type.String({ minLength: 3, maxLength: 140 }),
            branch: Type.String({ minLength: 1, maxLength: 200 }),
            message: Type.String({ minLength: 1, maxLength: 500 }),
          },
          { additionalProperties: false },
        ),
        execute: async (args, _api, execution) => {
          permit("read");
          const dir = dirOf(args.repo);
          const signal = execution?.abortSignal;
          const diff = JSON.parse((await run({ kind: "changes", dir }, signal)).stdout) as {
            added: string[];
            modified: string[];
            deleted: string[];
            truncated: boolean;
          };
          const files: { path: string; content?: string; delete?: boolean }[] = [];
          const skipped: string[] = [];
          for (const file of [...diff.added, ...diff.modified]) {
            try {
              files.push({
                path: file,
                content: (await run({ kind: "read", path: `${dir}/${file}` }, signal)).stdout,
              });
            } catch {
              skipped.push(file);
            }
          }
          for (const file of diff.deleted) files.push({ path: file, delete: true });
          if (!files.length)
            return answer({ published: 0, skipped, note: "nothing differs from the checkout" });
          const commit = await github.commitFiles(
            { repo: args.repo, branch: args.branch, message: args.message, files },
            context.principal.resources,
          );
          // Why not always accept: a file that could not be published must still show up as changed.
          const complete = !skipped.length && !diff.truncated;
          if (complete) await run({ kind: "changes", dir, accept: true }, signal);
          return answer({
            ...commit,
            skipped,
            truncated: diff.truncated,
            baselineUpdated: complete,
          });
        },
      }),
      defineTool({
        name: "sandbox_read_file",
        description:
          "Read a UTF-8 regular file relative to this session’s workspace. Traversal and symlinks are denied.",
        replay: "safe",
        parameters: Type.Object({ path }, { additionalProperties: false }),
        execute: (args, _api, execution) =>
          invoke({ kind: "read", path: args.path }, execution?.abortSignal),
      }),
      defineTool({
        name: "sandbox_write_file",
        description:
          "Atomically replace a whole UTF-8 file relative to this session’s workspace. Parent directories must exist. No append or patch.",
        replay: "safe",
        parameters: Type.Object(
          { path, content: Type.String({ maxLength: LIMITS.inputBytes }) },
          { additionalProperties: false },
        ),
        execute: (args, _api, execution) =>
          invoke({ kind: "write", path: args.path, content: args.content }, execution?.abortSignal),
      }),
    ],
  });
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { LIMITS, SandboxRuntime } = await import("./runtime");

  function tools(
    binding?: SandboxBinding,
    sessionId = "one",
    sessions = [sessionId],
    resources = ["read", "write", "execute"].map((r) => `sandbox:${sessionId}:${r}`),
  ) {
    return create({
      env: Object.assign(Object.create(null), {
        SANDBOX_CONTAINER: binding,
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
      call(registered, "execute", { code: "", timeoutMs: LIMITS.timeoutMs + 1 }),
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
      { code: "for(;;){}", timeoutMs: 100 },
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
    const fixture = container(async () =>
      processOutput("a".repeat(40_000), "\u754c".repeat(10_000)),
    );
    const runtime = new SandboxRuntime(fixture.boundary);
    await assert.rejects(
      runtime.run("flood", { kind: "execute", code: "console.log(1)", timeoutMs: 100 }),
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
      code: 'console.log("hi")',
      timeoutMs: 100,
    });
    assert.equal(result.exitCode, 4);
    assert.deepEqual(argv, ["node", "-e", 'console.log("hi")']);
    assert.deepEqual(
      options?.env,
      { HOME: "/tmp", CI: "1" },
      "no application secret reaches the container",
    );
    assert.equal(options?.cwd, "/workspace");
    await assert.rejects(runtime.run("file", { kind: "read", path: "a" }), /sandbox_file_error/);
    failure = true;
    await assert.rejects(runtime.run("transport", { kind: "read", path: "a" }), {
      message: "sandbox_transport_error",
    });
  });

  test("native runtime restores the last snapshot after a destroy and snapshots after writes, not reads", async () => {
    const started: unknown[] = [];
    let running = false;
    let snapshots = 0;
    const saved: ContainerSnapshot[] = [];
    const boundary = {
      get running() {
        return running;
      },
      start(options: unknown) {
        started.push(options);
        running = true;
      },
      async exec() {
        return processOutput("");
      },
      async destroy() {
        running = false;
      },
      async snapshotContainer() {
        return { id: `snap-${++snapshots}`, size: 1 };
      },
    } as unknown as ConstructorParameters<typeof SandboxRuntime>[0];
    const runtime = new SandboxRuntime(boundary, {
      load: async () => saved.at(-1),
      save: async (snapshot) => void saved.push(snapshot),
    });
    const write: Operation = { kind: "write", path: "a", content: "x" };
    await runtime.run("first", write);
    await runtime.run("read", { kind: "read", path: "a" });
    assert.deepEqual(
      saved.map((snapshot) => snapshot.id),
      ["snap-1"],
    );
    assert.equal((started[0] as { image?: string }).image, "cloudflare/debian-trixie");
    await boundary.destroy();
    await runtime.run("second", write);
    assert.deepEqual((started[1] as { containerSnapshot?: unknown }).containerSnapshot, {
      id: "snap-1",
      size: 1,
    });
    assert.equal((started[1] as { image?: string }).image, undefined);
  });

  test("a sandbox wildcard grants only the conversation's own session, never another", async () => {
    const seen: string[] = [];
    const binding: SandboxBinding = {
      getByName(name) {
        seen.push(name);
        return { run: async () => ok, cancel: async () => {} };
      },
    };
    const wildcard = ["read", "write", "execute"].map((r) => `sandbox:*:${r}`);
    await call(tools(binding, "one", ["one"], wildcard), "read_file", { path: "a" });
    assert.equal(seen.length, 1);
    await assert.rejects(
      call(tools(binding, "two", ["one"], wildcard), "read_file", { path: "a" }),
      /sandbox_forbidden/,
      "the session list still has to include the conversation",
    );
    assert.equal(seen.length, 1);
  });

  // --- the coding tools: shell, checkout, publish ------------------------------------------------
  const { vi } = import.meta.vitest;
  const { generateKeyPairSync } = await import("node:crypto");
  const A = "a".repeat(40);
  const githubEnv = {
    GITHUB_APP_ID: "123",
    GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    GITHUB_REPOSITORIES: '{"team/*":42}',
  };
  /** A fake GitHub for the routes a test cares about; it records every call as "METHOD path". */
  function github(routes: Record<string, (body: any) => Response | object>) {
    const calls: { key: string; body: any }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname.endsWith("/access_tokens"))
        return Response.json(
          { token: "t", expires_at: new Date(Date.now() + 3_600_000).toISOString() },
          { status: 201 },
        );
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      calls.push({ key, body });
      const handler = routes[key];
      if (!handler) return new Response("{}", { status: 404 });
      const out = handler(body);
      return out instanceof Response ? out : Response.json(out);
    });
    return calls;
  }
  function coder(binding: SandboxBinding, resources: string[]) {
    return create({
      env: Object.assign(Object.create(null), { SANDBOX_CONTAINER: binding, ...githubEnv }),
      sessionId: "one",
      principal: { id: "member", sessions: ["one"], resources },
    }).tools!;
  }
  const grants = (...kinds: string[]) => kinds.map((kind) => `sandbox:one:${kind}`);
  const run = (tools: ReturnType<typeof coder>, name: string, input: object) => {
    const tool = tools.find((tool) => tool.name === name)!;
    return Reflect.apply(tool.execute, tool, [input, undefined, {}]);
  };

  test("the shell needs the execute grant, defaults its timeout and keeps its working directory", async () => {
    const seen: Operation[] = [];
    const binding: SandboxBinding = {
      getByName: () => ({
        run: async (_id, operation) => {
          seen.push(operation);
          return ok;
        },
        cancel: async () => {},
      }),
    };
    await run(coder(binding, grants("execute")), "sandbox_shell", {
      command: "npm test",
      cwd: "repo",
    });
    assert.deepEqual(seen, [
      { kind: "shell", command: "npm test", timeoutMs: 120_000, cwd: "repo" },
    ]);
    await assert.rejects(
      run(coder(binding, grants("read", "write")), "sandbox_shell", { command: "ls" }),
      /sandbox_forbidden/,
    );
    await assert.rejects(
      run(coder(binding, grants("execute")), "sandbox_shell", {
        command: "ls",
        timeoutMs: LIMITS.shellTimeoutMs + 1,
      }),
      /sandbox_invalid_input/,
      "an out-of-range timeout is refused before it reaches the container",
    );
    assert.equal(seen.length, 1);
  });

  test("a checkout streams the archive in, returns the sha and the repository's own context, and downloads nothing without the grants", async () => {
    const received: string[] = [];
    const binding: SandboxBinding = {
      getByName: () => ({
        run: async (_id, operation) => {
          assert.equal(operation.kind, "checkout");
          if (operation.kind === "checkout") {
            assert.equal(operation.dir, "project");
            received.push(await new Response(operation.archive).text());
          }
          return {
            stdout: JSON.stringify({
              files: 2,
              instructions: { "AGENTS.md": "Run npm test." },
              skills: [],
            }),
            stderr: "",
            exitCode: 0,
          };
        },
        cancel: async () => {},
      }),
    };
    const calls = github({
      "GET /repos/team/project/commits/HEAD": () => ({ sha: A }),
      [`GET /repos/team/project/tarball/${A}`]: () =>
        new Response(null, { status: 302, headers: { location: "https://codeload.example/blob" } }),
      "GET /blob": () => new Response("TARBALL"),
    });
    const out = await run(
      coder(binding, [...grants("write"), "github:team/*:read"]),
      "sandbox_checkout",
      {
        repo: "team/project",
      },
    );
    assert.deepEqual(JSON.parse(out.output[0].text), {
      repo: "team/project",
      dir: "project",
      sha: A,
      files: 2,
      instructions: { "AGENTS.md": "Run npm test." },
      skills: [],
    });
    assert.deepEqual(received, ["TARBALL"]);
    const before = calls.length;
    await assert.rejects(
      run(coder(binding, ["github:team/*:read"]), "sandbox_checkout", { repo: "team/project" }),
      /sandbox_forbidden/,
    );
    await assert.rejects(
      run(coder(binding, grants("write")), "sandbox_checkout", { repo: "team/project" }),
      /github_forbidden/,
    );
    assert.equal(calls.length, before, "a conversation without both grants downloads nothing");
  });

  test("publishing commits what differs, skips what it cannot send, and moves the baseline only when nothing was skipped", async () => {
    const ops: Operation[] = [];
    let diff = {
      added: ["src/new.ts"],
      modified: ["src/a.ts"],
      deleted: ["src/old.ts"],
      truncated: false,
    };
    const binding: SandboxBinding = {
      getByName: () => ({
        run: async (_id, operation) => {
          ops.push(operation);
          if (operation.kind === "changes")
            return { stdout: JSON.stringify(diff), stderr: "", exitCode: 0 };
          if (operation.kind === "read")
            return { stdout: `content of ${operation.path}`, stderr: "", exitCode: 0 };
          throw new Error("unexpected");
        },
        cancel: async () => {},
      }),
    };
    const calls = github({
      "GET /repos/team/project/git/ref/heads/fix": () => ({ object: { sha: A } }),
      [`GET /repos/team/project/git/commits/${A}`]: () => ({ tree: { sha: "b".repeat(40) } }),
      "POST /repos/team/project/git/trees": () => ({ sha: "c".repeat(40) }),
      "POST /repos/team/project/git/commits": () => ({ sha: "d".repeat(40) }),
      "PATCH /repos/team/project/git/refs/heads/fix": () => ({}),
    });
    const tools = coder(binding, [...grants("read"), "github:team/*:read", "github:team/*:write"]);
    const publish = async () =>
      JSON.parse(
        (
          await run(tools, "sandbox_publish", {
            repo: "team/project",
            branch: "fix",
            message: "Fix",
          })
        ).output[0].text,
      );
    const done = await publish();
    assert.deepEqual(done, {
      commit: "d".repeat(40),
      files: 3,
      skipped: [],
      truncated: false,
      baselineUpdated: true,
    });
    assert.deepEqual(
      calls.find((call) => call.key === "POST /repos/team/project/git/trees")?.body.tree,
      [
        {
          path: "src/new.ts",
          mode: "100644",
          type: "blob",
          content: "content of project/src/new.ts",
        },
        { path: "src/a.ts", mode: "100644", type: "blob", content: "content of project/src/a.ts" },
        { path: "src/old.ts", mode: "100644", type: "blob", sha: null },
      ],
    );
    assert.deepEqual(ops.at(-1), { kind: "changes", dir: "project", accept: true });
    // A path the read operation refuses is reported and keeps the baseline, so it is not forgotten.
    ops.length = 0;
    diff = { added: ["has space.txt"], modified: ["src/a.ts"], deleted: [], truncated: false };
    const partial = await publish();
    assert.deepEqual([partial.skipped, partial.baselineUpdated], [["has space.txt"], false]);
    assert.ok(
      !ops.some((op) => op.kind === "changes" && op.accept),
      "the baseline stays where it was",
    );
    // Nothing differs: no commit at all.
    ops.length = 0;
    calls.length = 0;
    diff = { added: [], modified: [], deleted: [], truncated: false };
    assert.equal((await publish()).published, 0);
    assert.equal(calls.length, 0);
  });
}
