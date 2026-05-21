// Crash-loop guard: 5 consecutive errored turns disable the loop so we
// don't keep pushing followUps to a model that's burning quota on errors.

import { describe, it, expect } from "vitest";
import {
  acDrive,
  acOn,
  acPush,
  createAcState,
  DEFAULT_ERROR_THRESHOLD,
  evaluateAgentEnd,
} from "../extensions/core.js";

describe("crash-loop guard: default state", () => {
  it("fresh state has consecutiveErrors=0 and the default threshold", () => {
    const s = createAcState();
    expect(s.consecutiveErrors).toBe(0);
    expect(s.errorThreshold).toBe(DEFAULT_ERROR_THRESHOLD);
    expect(DEFAULT_ERROR_THRESHOLD).toBe(5);
  });

  it("createAcState accepts a custom threshold for tests", () => {
    const s = createAcState({ errorThreshold: 3 });
    expect(s.errorThreshold).toBe(3);
  });
});

describe("crash-loop guard: counter behavior", () => {
  it("errored turns increment the counter", () => {
    const s = createAcState();
    acPush(s, "task");
    acOn(s);
    evaluateAgentEnd(s, { errored: true });
    expect(s.consecutiveErrors).toBe(1);
    evaluateAgentEnd(s, { errored: true });
    expect(s.consecutiveErrors).toBe(2);
  });

  it("a single non-errored turn resets the counter to 0", () => {
    const s = createAcState();
    acPush(s, "task");
    acOn(s);
    evaluateAgentEnd(s, { errored: true });
    evaluateAgentEnd(s, { errored: true });
    expect(s.consecutiveErrors).toBe(2);
    evaluateAgentEnd(s, { errored: false });
    expect(s.consecutiveErrors).toBe(0);
  });

  it("omitting opts treats the turn as non-errored (back-compat)", () => {
    const s = createAcState();
    acPush(s, "task");
    acOn(s);
    s.consecutiveErrors = 2;
    evaluateAgentEnd(s);
    expect(s.consecutiveErrors).toBe(0);
  });

  it("non-errored turns when counter is already 0 stay at 0", () => {
    const s = createAcState();
    acPush(s, "task");
    acOn(s);
    evaluateAgentEnd(s, { errored: false });
    expect(s.consecutiveErrors).toBe(0);
  });
});

describe("crash-loop guard: threshold trips loop", () => {
  it("reaching the threshold disables the loop and returns undefined", () => {
    const s = createAcState({ errorThreshold: 3 });
    acPush(s, "task");
    acOn(s);
    expect(s.enabled).toBe(true);

    evaluateAgentEnd(s, { errored: true }); // 1
    evaluateAgentEnd(s, { errored: true }); // 2
    expect(s.enabled).toBe(true);

    const text = evaluateAgentEnd(s, { errored: true }); // 3 — trips
    expect(text).toBeUndefined();
    expect(s.enabled).toBe(false);
    expect(s.consecutiveErrors).toBe(3);
  });

  it("disabled by threshold stays disabled across further agent_ends", () => {
    const s = createAcState({ errorThreshold: 2 });
    acPush(s, "task");
    acOn(s);
    evaluateAgentEnd(s, { errored: true });
    evaluateAgentEnd(s, { errored: true });
    expect(s.enabled).toBe(false);
    // After trip, subsequent agent_ends (even errored) are no-ops.
    const text = evaluateAgentEnd(s, { errored: true });
    expect(text).toBeUndefined();
  });

  it("default threshold of 5 trips on the fifth errored turn", () => {
    const s = createAcState();
    acPush(s, "task");
    acOn(s);
    for (let i = 1; i <= 4; i++) {
      const text = evaluateAgentEnd(s, { errored: true });
      expect(text, `turn ${i} should still poke`).toBeDefined();
      expect(s.enabled).toBe(true);
    }
    const text = evaluateAgentEnd(s, { errored: true });
    expect(text).toBeUndefined();
    expect(s.enabled).toBe(false);
    expect(s.consecutiveErrors).toBe(5);
  });

  it("a non-errored turn before the threshold rescues the loop", () => {
    const s = createAcState({ errorThreshold: 3 });
    acPush(s, "task");
    acOn(s);
    evaluateAgentEnd(s, { errored: true });
    evaluateAgentEnd(s, { errored: true });
    evaluateAgentEnd(s, { errored: false }); // resets
    evaluateAgentEnd(s, { errored: true });
    evaluateAgentEnd(s, { errored: true });
    // 4 errored turns total, but the reset means we're only at 2 consecutive
    expect(s.enabled).toBe(true);
    expect(s.consecutiveErrors).toBe(2);
  });

  it("ac on re-enables and clears the counter", () => {
    const s = createAcState({ errorThreshold: 2 });
    acPush(s, "task");
    acOn(s);
    evaluateAgentEnd(s, { errored: true });
    evaluateAgentEnd(s, { errored: true });
    expect(s.enabled).toBe(false);
    expect(s.consecutiveErrors).toBe(2);
    const r = acOn(s);
    expect(r.isError).toBeFalsy();
    expect(s.enabled).toBe(true);
    expect(s.consecutiveErrors).toBe(0);
  });

  it("ac clear resets the counter", () => {
    const s = createAcState();
    acPush(s, "task");
    acOn(s);
    evaluateAgentEnd(s, { errored: true });
    expect(s.consecutiveErrors).toBe(1);
    s.queue.length = 0;
    s.enabled = false;
    s.onDrain = undefined;
    s.consecutiveErrors = 0; // simulating acClear
    expect(s.consecutiveErrors).toBe(0);
  });
});

describe("crash-loop guard: drive mode", () => {
  it("trips in drive mode too", () => {
    const s = createAcState({ errorThreshold: 2 });
    acDrive(s, "find work");
    acOn(s);
    evaluateAgentEnd(s, { errored: true });
    const text = evaluateAgentEnd(s, { errored: true });
    expect(text).toBeUndefined();
    expect(s.enabled).toBe(false);
  });

  it("after trip, the stored onDrain is preserved (so ac on resumes cleanly)", () => {
    const s = createAcState({ errorThreshold: 2 });
    acDrive(s, "find work");
    acOn(s);
    evaluateAgentEnd(s, { errored: true });
    evaluateAgentEnd(s, { errored: true });
    expect(s.enabled).toBe(false);
    expect(s.onDrain).toBeDefined();
  });
});
