import { describe, expect, it } from "vitest";

import { SerialQueue } from "../src/lock.ts";

function deferredTask(record: number[], id: number, delayMs: number): () => Promise<number> {
  return () =>
    new Promise<number>((resolve) => {
      setTimeout(() => {
        record.push(id);
        resolve(id);
      }, delayMs);
    });
}

describe("SerialQueue", () => {
  it("runs tasks strictly in submission order regardless of duration", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    // Later tasks finish faster on their own; serialisation must still hold.
    const p1 = queue.enqueue(deferredTask(order, 1, 30));
    const p2 = queue.enqueue(deferredTask(order, 2, 5));
    const p3 = queue.enqueue(deferredTask(order, 3, 1));
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps running after a task rejects", async () => {
    const queue = new SerialQueue();
    const failed = queue.enqueue(() => Promise.reject(new Error("boom")));
    await expect(failed).rejects.toThrow("boom");
    const ok = await queue.enqueue(() => Promise.resolve("ok"));
    expect(ok).toBe("ok");
  });

  it("onIdle resolves after every queued task settles", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    queue.enqueue(deferredTask(order, 1, 10));
    queue.enqueue(deferredTask(order, 2, 10));
    await queue.onIdle();
    expect(order).toEqual([1, 2]);
  });
});
