/**
 * Runs async work one at a time, in call order. A Durable Object's input gate only covers storage
 * awaits; work that also awaits the harness has to be ordered here. Why not `blockConcurrencyWhile`:
 * it stops every other event on the object, resets the object after 30 s, and the platform rules
 * reserve it for one-time initialization.
 */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("work runs one at a time in call order, and a failure does not stop the next", async () => {
    const run = serial();
    const log: string[] = [];
    const slow = run(async () => {
      log.push("a start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      log.push("a end");
      throw new Error("a failed");
    });
    const next = run(async () => {
      log.push("b");
      return "b done";
    });
    await expect(slow).rejects.toThrow("a failed");
    expect(await next).toBe("b done");
    expect(log).toEqual(["a start", "a end", "b"]);
  });
}
