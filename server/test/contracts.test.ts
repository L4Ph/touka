import { test } from "node:test";
import assert from "node:assert/strict";
import { isSubmitInput } from "@remote-agent/adapter-contract";

test("core accepts only bounded transport-independent submissions", () => {
  const input = { sessionId: "session-1", operationId: "op_1", input: "Explain this chart" };
  assert.equal(isSubmitInput(input), true);
  for (const invalid of [
    null,
    {},
    { ...input, source: "slack" },
    { ...input, input: " " },
    { ...input, input: "x".repeat(16_001) },
    { ...input, operationId: "../other" },
    { ...input, sessionId: "s".repeat(129) },
  ]) {
    assert.equal(isSubmitInput(invalid), false);
  }
});
