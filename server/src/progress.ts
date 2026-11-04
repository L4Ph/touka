import type nodeAssert from "node:assert/strict";
import type { LiveState, TaskId } from "@earendil-works/pi-durable";

/** Public progress is a projection, never raw thinking, tool arguments, output, or error details. */
export function progressText(live: Readonly<LiveState> | undefined): string {
  if (!live?.run)
    return live?.runFailure
      ? `The last run ended without an answer (${live.runFailure.reason}).`
      : "No task is running.";
  const prefix = `Working — tool round ${live.run.turns}.`;
  if (live.generation?.retry) return `${prefix} Waiting to retry the model request.`;
  if (live.compactions?.some((task) => task.blocking)) return `${prefix} Compacting context.`;
  const tools = [
    ...new Set(
      (live.tools ?? [])
        .filter((tool) => tool.status === "running" && /^[a-zA-Z0-9_.-]{1,64}$/.test(tool.name))
        .map((tool) => tool.name),
    ),
  ].slice(0, 8);
  return tools.length
    ? `${prefix} Running tools: ${tools.join(", ")}.`
    : `${prefix} Waiting for the next model or tool step.`;
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  test("progress identifies active tools without exposing command output or provider errors", () => {
    const state: LiveState = {
      run: { taskId: 1 as TaskId, inputs: [], turns: 4 },
      tools: [{ callId: "call", name: "bash", status: "running", output: "SECRET OUTPUT" }],
    };
    assert.equal(progressText(state), "Working — tool round 4. Running tools: bash.");
    state.generation = { attempt: 2, retry: { at: 1, error: "SECRET PROVIDER ERROR" } };
    assert.equal(
      progressText(state),
      "Working — tool round 4. Waiting to retry the model request.",
    );
    assert.equal(progressText(undefined), "No task is running.");
  });
}
