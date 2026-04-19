// New-action tests (v1): status, drive, undrive, update, and the
// drain-hook semantics of on/done/evaluateAgentEnd when onDrain is
// installed.

import { describe, it, expect } from "vitest";
import {
  acClear,
  acDone,
  acDrive,
  acInsert,
  acOff,
  acOn,
  acPush,
  acStatus,
  acUndrive,
  acUpdate,
  createAcState,
  evaluateAgentEnd,
  type AcState,
} from "../extensions/core.js";

describe("status action", () => {
  it("returns fresh state: disabled, empty, no drain", () => {
    const s = createAcState();
    expect(acStatus(s)).toEqual({
      enabled: false,
      queueLength: 0,
      hasDrain: false,
    });
  });

  it("reflects queue length", () => {
    const s = createAcState();
    acPush(s, "a");
    acPush(s, "b");
    acPush(s, "c");
    expect(acStatus(s).queueLength).toBe(3);
  });

  it("reflects enabled state", () => {
    const s = createAcState();
    acPush(s, "a");
    acOn(s);
    expect(acStatus(s).enabled).toBe(true);
    acOff(s);
    expect(acStatus(s).enabled).toBe(false);
  });

  it("reflects hasDrain after drive/undrive", () => {
    const s = createAcState();
    expect(acStatus(s).hasDrain).toBe(false);
    acDrive(s, "find next work");
    expect(acStatus(s).hasDrain).toBe(true);
    acUndrive(s);
    expect(acStatus(s).hasDrain).toBe(false);
  });
});

describe("drive / undrive actions", () => {
  it("drive installs onDrain that returns the given prompt", () => {
    const s = createAcState();
    acDrive(s, "do the next thing");
    expect(s.onDrain).toBeDefined();
    expect(s.onDrain?.()).toBe("do the next thing");
  });

  it("drive trims whitespace from the prompt", () => {
    const s = createAcState();
    acDrive(s, "  padded  ");
    expect(s.onDrain?.()).toBe("padded");
  });

  it("drive errors on empty prompt", () => {
    const s = createAcState();
    const r = acDrive(s, "");
    expect(r.isError).toBe(true);
    expect(s.onDrain).toBeUndefined();
  });

  it("drive errors on whitespace-only prompt", () => {
    const s = createAcState();
    const r = acDrive(s, "   \t\n  ");
    expect(r.isError).toBe(true);
    expect(s.onDrain).toBeUndefined();
  });

  it("drive errors on undefined prompt", () => {
    const s = createAcState();
    const r = acDrive(s, undefined);
    expect(r.isError).toBe(true);
    expect(s.onDrain).toBeUndefined();
  });

  it("drive replaces a previously installed drive", () => {
    const s = createAcState();
    acDrive(s, "first");
    acDrive(s, "second");
    expect(s.onDrain?.()).toBe("second");
  });

  it("undrive clears onDrain", () => {
    const s = createAcState();
    acDrive(s, "x");
    acUndrive(s);
    expect(s.onDrain).toBeUndefined();
  });

  it("undrive is idempotent", () => {
    const s = createAcState();
    acUndrive(s);
    expect(s.onDrain).toBeUndefined();
    acUndrive(s);
    expect(s.onDrain).toBeUndefined();
  });
});

describe("update action", () => {
  it("replaces the task at the given position", () => {
    const s = createAcState();
    acPush(s, "a");
    acPush(s, "b");
    acPush(s, "c");
    acUpdate(s, "BBB", 1);
    expect(s.queue).toEqual(["a", "BBB", "c"]);
  });

  it("works on position 0 (front)", () => {
    const s = createAcState();
    acPush(s, "a");
    acPush(s, "b");
    acUpdate(s, "AAA", 0);
    expect(s.queue).toEqual(["AAA", "b"]);
  });

  it("errors when position is out of bounds", () => {
    const s = createAcState();
    acPush(s, "a");
    const r = acUpdate(s, "x", 5);
    expect(r.isError).toBe(true);
    expect(s.queue).toEqual(["a"]);
  });

  it("errors when position is negative", () => {
    const s = createAcState();
    acPush(s, "a");
    const r = acUpdate(s, "x", -1);
    expect(r.isError).toBe(true);
    expect(s.queue).toEqual(["a"]);
  });

  it("errors when position is not provided", () => {
    const s = createAcState();
    acPush(s, "a");
    const r = acUpdate(s, "x", undefined);
    expect(r.isError).toBe(true);
    expect(s.queue).toEqual(["a"]);
  });

  it("errors when task is not provided", () => {
    const s = createAcState();
    acPush(s, "a");
    const r = acUpdate(s, undefined, 0);
    expect(r.isError).toBe(true);
    expect(s.queue).toEqual(["a"]);
  });

  it("errors on empty queue", () => {
    const s = createAcState();
    const r = acUpdate(s, "x", 0);
    expect(r.isError).toBe(true);
  });
});

describe("on / done with drain hook installed", () => {
  it("on is permitted on empty queue when onDrain is installed", () => {
    const s = createAcState();
    acDrive(s, "find work");
    const r = acOn(s);
    expect(r.isError).toBeFalsy();
    expect(s.enabled).toBe(true);
  });

  it("done does not auto-disable when queue empties in drive mode", () => {
    const s = createAcState();
    acPush(s, "a");
    acDrive(s, "find work");
    acOn(s);
    acDone(s);
    expect(s.queue).toEqual([]);
    expect(s.enabled).toBe(true);
  });

  it("done on last item in fifo mode (no drain) still auto-disables", () => {
    const s = createAcState();
    acPush(s, "a");
    acOn(s);
    acDone(s);
    expect(s.enabled).toBe(false);
  });
});

describe("evaluateAgentEnd — drain mode", () => {
  it("injects stored prompt when queue is empty and enabled", () => {
    const s = createAcState();
    acDrive(s, "find the next thing to do");
    acOn(s);
    const text = evaluateAgentEnd(s);
    expect(text).toBe("find the next thing to do");
    expect(s.enabled).toBe(true);
  });

  it("stays enabled after drain injection", () => {
    const s = createAcState();
    acDrive(s, "go");
    acOn(s);
    evaluateAgentEnd(s);
    expect(s.enabled).toBe(true);
    // Second drain still fires.
    const text2 = evaluateAgentEnd(s);
    expect(text2).toBe("go");
  });

  it("queued tasks take precedence over drain injection", () => {
    const s = createAcState();
    acDrive(s, "find work");
    acPush(s, "specific task");
    acOn(s);
    const text = evaluateAgentEnd(s);
    expect(text).toContain("specific task");
    expect(text).not.toContain("find work");
  });

  it("returns undefined when onDrain returns undefined and disables", () => {
    const s: AcState = createAcState();
    s.onDrain = () => undefined;
    s.enabled = true;
    // queue is empty, onDrain returns undefined
    const text = evaluateAgentEnd(s);
    expect(text).toBeUndefined();
    expect(s.enabled).toBe(false);
  });
});

describe("clear action: full reset", () => {
  it("clear empties queue, disables, and clears onDrain", () => {
    const s = createAcState();
    acPush(s, "a");
    acPush(s, "b");
    acDrive(s, "find work");
    acOn(s);
    acClear(s);
    expect(s.queue).toEqual([]);
    expect(s.enabled).toBe(false);
    expect(s.onDrain).toBeUndefined();
  });
});
