import type { ToolExecutionResult } from "@earendil-works/pi-durable";

/** Preserve the command's result, but never report persistence before the container saves it. */
export async function checkpointToolResult(
  name: string,
  result: ToolExecutionResult,
  save: () => Promise<void>,
): Promise<ToolExecutionResult> {
  if (!["bash", "write", "edit"].includes(name)) return result;
  try {
    await save();
  } catch (error) {
    console.error("sandbox_checkpoint_failed", String(error));
    return {
      ...result,
      isError: true,
      control: { ...result.control, terminate: true },
      diagnostics: [
        ...(result.diagnostics ?? []),
        {
          severity: "error",
          code: "workspace_checkpoint_failed",
          message:
            "Workspace checkpoint failed. Work may not survive a restart. Do not repeat the command.",
        },
      ],
    };
  }
  return {
    ...result,
    diagnostics: [
      ...(result.diagnostics ?? []),
      {
        severity: "info",
        code: "workspace_saved",
        message: "Workspace checkpoint saved.",
      },
    ],
  };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const result: ToolExecutionResult = {
    output: [{ type: "text", text: "file written" }],
    structuredOutput: { exitCode: 0 },
  };

  test("a mutating tool cannot settle before its checkpoint completes", async () => {
    let release = () => {};
    const saved = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = false;
    const response = checkpointToolResult("write", result, () => saved).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await response).toEqual({
      ...result,
      diagnostics: [
        {
          severity: "info",
          code: "workspace_saved",
          message: "Workspace checkpoint saved.",
        },
      ],
    });
  });

  test("checkpoint failure preserves evidence of the command and requests termination, not replay", async () => {
    const response = await checkpointToolResult("bash", result, async () => {
      throw new Error("snapshot unavailable");
    });
    expect(response.isError).toBe(true);
    expect(response.control?.terminate).toBe(true);
    expect(response.output).toEqual(result.output);
    expect(response.structuredOutput).toEqual(result.structuredOutput);
    expect(response.diagnostics).toEqual([
      {
        severity: "error",
        code: "workspace_checkpoint_failed",
        message:
          "Workspace checkpoint failed. Work may not survive a restart. Do not repeat the command.",
      },
    ]);
  });

  test("read-only tools do not create checkpoints or change results", async () => {
    expect(
      await checkpointToolResult("read", result, async () => {
        throw new Error("must not save");
      }),
    ).toBe(result);
  });
}
