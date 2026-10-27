import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ToolContext } from "../../tools";
import { LIMITS, validate, type Operation, type SandboxBinding } from "./runtime";

export function create(context: ToolContext) {
  async function invoke(operation: Operation, signal?: AbortSignal) {
    validate(operation);
    if (
      !context.principal.sessions.includes(context.sessionId) ||
      !context.principal.resources.includes(`sandbox:${context.sessionId}:${operation.kind}`)
    )
      throw new Error("sandbox_forbidden");
    const binding = (context.env as unknown as { SANDBOX?: SandboxBinding }).SANDBOX;
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
        (operation.kind === "execute" ? operation.timeoutMs : LIMITS.timeoutMs) + 1000,
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
      return {
        output: [{ type: "text" as const, text: JSON.stringify(result) }],
        isError: result.exitCode !== 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      throw new Error(
        /^sandbox_(timeout|aborted|output_limit|file_error|busy|transport_error|unconfigured)$/.test(
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
  const path = Type.String({ minLength: 1, maxLength: 256 });
  return defineExtension({
    name: "sandbox",
    tools: [
      defineTool({
        name: "sandbox_execute",
        description:
          "Run Python or JavaScript in this session’s isolated offline Linux container. Never replay automatically. No host shell or deployment.",
        replay: "unsafe",
        parameters: Type.Object(
          {
            language: Type.Union([Type.Literal("python"), Type.Literal("javascript")]),
            code: Type.String({ maxLength: LIMITS.inputBytes }),
            timeoutMs: Type.Integer({ minimum: 1, maximum: LIMITS.timeoutMs }),
          },
          { additionalProperties: false },
        ),
        execute: (args, _api, execution) =>
          invoke(
            {
              kind: "execute",
              language: args.language,
              code: args.code,
              timeoutMs: args.timeoutMs,
            },
            execution?.abortSignal,
          ),
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
