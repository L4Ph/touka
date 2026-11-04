import type nodeAssert from "node:assert/strict";
import { STREAM_LIMITS, type SessionStreamFrame } from "./stream-protocol";

export function encodeStreamFrame(frame: SessionStreamFrame) {
  const data = JSON.stringify(frame);
  const bytes = new TextEncoder().encode(data).byteLength;
  return bytes > STREAM_LIMITS.frameBytes ? null : { data, bytes };
}

if (import.meta.vitest) {
  const { test } = import.meta.vitest;
  const assert: typeof nodeAssert = (await import("node:assert/strict")).default;
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const { Harness, createRegistry, LiveDoc } = await import("@earendil-works/pi-durable");
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  const { createModels } = await import("@earendil-works/pi-ai/models");
  const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");

  test("Pi 1.5 preserves a 1.4 SQLite conversation and streams its continued failure as native view changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "touka-pi-upgrade-"));
    const path = join(dir, "session.sqlite");
    const seed = new DatabaseSync(path);
    try {
      seed.exec(await readFile(new URL("../fixtures/pi-1.4-session.sql", import.meta.url), "utf8"));
    } finally {
      seed.close();
    }
    const storage = await openNodeSqliteStorage(path);
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      context,
    );
    try {
      const root = await harness.root(context);
      const watch = await root.watch(context);
      const snapshot = encodeStreamFrame({ type: "snapshot", sequence: 0, snapshot: watch.value });
      assert.ok(snapshot);
      assert.match(snapshot.data, /Preserve this message across the Pi 1.5 upgrade/);
      const frames: string[] = [];
      watch.start(async (call) => {
        if (call.kind !== "value") return;
        const frame = encodeStreamFrame({
          type: "changes",
          sequence: frames.length + 1,
          ops: call.ops,
        });
        assert.ok(frame);
        frames.push(frame.data);
      });
      const receipt = await root.submit({ type: "continue", requestId: "resume-1" }, context);
      const outcome = await receipt.wait(context);
      assert.equal(outcome.status, "unanswered");
      assert.equal(outcome.type, "continue");
      const again = await root.submit({ type: "continue", requestId: "resume-1" }, context);
      assert.equal(again.id, receipt.id);
      const live = await harness.snapshot(LiveDoc, root.id, context);
      assert.equal(live?.runFailure?.reason, "no_model");
      assert.ok(frames.length > 0);
      assert.ok(frames.every((frame) => JSON.parse(frame).type === "changes"));
      await watch.stop();
    } finally {
      await harness.close(context);
      await storage.close(context);
      await rm(dir, { recursive: true, force: true });
    }
  });
}
