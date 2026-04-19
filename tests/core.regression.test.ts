// Regression tests — verify existing ac behavior (the behavior of the
// original loose ~/.pi/agent/extensions/auto-continue.ts) is preserved
// after the refactor into core.ts. All new actions (status/drive/undrive/
// update) are covered by core.new.test.ts.

import { describe, it, expect } from "vitest";
import {
  acClear,
  acDone,
  acInsert,
  acList,
  acOff,
  acOn,
  acPop,
  acPush,
  createAcState,
  evaluateAgentEnd,
} from "../extensions/core.js";

describe("regression: queue mutation actions", () => {
  it("push appends to the queue", () => {
    const s = createAcState();
    acPush(s, "a");
    acPush(s, "b");
    expect(s.queue).toEqual(["a", "b"]);
  });

  it("push with undefined task errors without mutating", () => {
    const s = createAcState();
    const r = acPush(s, undefined);
    expect(r.isError).toBe(true);
    expect(s.queue).toEqual([]);
  });

  it("insert places task at the given position", () => {
    const s = createAcState();
    acPush(s, "a");
    acPush(s, "c");
    acInsert(s, "b", 1);
    expect(s.queue).toEqual(["a", "b", "c"]);
  });

  it("insert clamps position to [0, queue.length]", () => {
    const s = createAcState();
    acPush(s, "a");
    acInsert(s, "z", 99);
    expect(s.queue).toEqual(["a", "z"]);
    acInsert(s, "0", -5);
    expect(s.queue).toEqual(["0", "a", "z"]);
  });

  it("insert with undefined task errors", () => {
    const s = createAcState();
    const r = acInsert(s, undefined, 0);
    expect(r.isError).toBe(true);
  });

  it("pop removes the last task", () => {
    const s = createAcState();
    acPush(s, "a");
    acPush(s, "b");
    acPop(s);
    expect(s.queue).toEqual(["a"]);
  });

  it("pop on empty queue returns a message and does not throw", () => {
    const s = createAcState();
    const r = acPop(s);
    expect(r.text).toContain("empty");
  });

  it("done shifts the front task", () => {
    const s = createAcState();
    acPush(s, "a");
    acPush(s, "b");
    acDone(s);
    expect(s.queue).toEqual(["b"]);
  });

  it("done on empty queue is a no-op", () => {
    const s = createAcState();
    const r = acDone(s);
    expect(r.text).toContain("empty");
  });
});

describe("regression: enable/disable actions", () => {
  it("on errors when queue is empty and no drain hook is installed", () => {
    const s = createAcState();
    const r = acOn(s);
    expect(r.isError).toBe(true);
    expect(s.enabled).toBe(false);
  });

  it("on succeeds when queue has items", () => {
    const s = createAcState();
    acPush(s, "a");
    const r = acOn(s);
    expect(r.isError).toBeFalsy();
    expect(s.enabled).toBe(true);
  });

  it("off preserves the queue", () => {
    const s = createAcState();
    acPush(s, "a");
    acOn(s);
    acOff(s);
    expect(s.enabled).toBe(false);
    expect(s.queue).toEqual(["a"]);
  });

  it("clear empties the queue and disables", () => {
    const s = createAcState();
    acPush(s, "a");
    acPush(s, "b");
    acOn(s);
    acClear(s);
    expect(s.queue).toEqual([]);
    expect(s.enabled).toBe(false);
  });

  it("done auto-disables when queue empties in fifo mode", () => {
    const s = createAcState();
    acPush(s, "a");
    acOn(s);
    acDone(s);
    expect(s.queue).toEqual([]);
    expect(s.enabled).toBe(false);
  });

  it("pop auto-disables when queue empties", () => {
    const s = createAcState();
    acPush(s, "a");
    acOn(s);
    acPop(s);
    expect(s.enabled).toBe(false);
  });
});

describe("regression: list / status rendering", () => {
  it("list returns a summary string that includes queue state", () => {
    const s = createAcState();
    acPush(s, "first");
    acPush(s, "second");
    const r = acList(s);
    expect(r.text).toContain("first");
    expect(r.text).toContain("second");
    expect(r.text).toContain("OFF");
  });

  it("list on empty queue returns an empty indicator", () => {
    const s = createAcState();
    const r = acList(s);
    expect(r.text.toLowerCase()).toContain("empty");
  });
});

describe("regression: evaluateAgentEnd — fifo mode", () => {
  it("returns undefined when disabled", () => {
    const s = createAcState();
    acPush(s, "a");
    expect(evaluateAgentEnd(s)).toBeUndefined();
  });

  it("injects followUp with the front task when enabled and non-empty", () => {
    const s = createAcState();
    acPush(s, "do the thing");
    acOn(s);
    const text = evaluateAgentEnd(s);
    expect(text).toContain("do the thing");
    expect(text).toContain("auto-continue");
  });

  it("auto-disables on empty queue (fifo mode)", () => {
    const s = createAcState();
    acPush(s, "a");
    acOn(s);
    acDone(s);
    // Queue is now empty, done already disabled it; evaluate is a no-op
    const text = evaluateAgentEnd(s);
    expect(text).toBeUndefined();
    expect(s.enabled).toBe(false);
  });
});
