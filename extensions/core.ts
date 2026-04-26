// Pure state machine for the ac auto-continue task queue.
//
// No pi runtime imports, no side effects outside the passed-in `state`.
// The extension wrapper (auto-continue.ts) is a thin adapter that wires
// these functions to `pi.registerTool` + `pi.on("agent_end", ...)` and
// translates results to/from the pi API shapes.

export type AcState = {
  enabled: boolean;
  queue: string[];
  /**
   * Drain-time hook. When the queue empties while `enabled` is true, the
   * `agent_end` handler calls this. A string is injected as the next
   * followUp; `undefined` disables the loop.
   *
   * v1 installs a constant-returning closure via the `drive` action
   * (`() => storedPrompt`); the `| undefined` return is reserved for
   * future strategies that may decide to stop dynamically.
   */
  onDrain?: () => string | undefined;
};

export type ActionResult = {
  text: string;
  isError?: boolean;
};

export type StatusResult = {
  enabled: boolean;
  queueLength: number;
  hasDrain: boolean;
};

export function createAcState(): AcState {
  return { enabled: false, queue: [] };
}

// ---------- status rendering helpers ----------

export function renderQueue(state: AcState): string {
  if (state.queue.length === 0) return "queue empty";
  return state.queue.map((t, i) => `${i === 0 ? "→" : " "} ${i}. ${t}`).join("\n");
}

export function renderSummary(state: AcState): string {
  return `auto-continue: ${state.enabled ? "ON" : "OFF"} | ${state.queue.length} tasks\n${renderQueue(state)}`;
}

// ---------- existing actions (parity with original auto-continue.ts) ----------

export function acList(state: AcState): ActionResult {
  return { text: renderSummary(state) };
}

export function acPush(state: AcState, task: string | undefined): ActionResult {
  if (!task) return { text: "error: task required", isError: true };
  state.queue.push(task);
  return { text: `pushed task ${state.queue.length - 1}: ${task}\n${renderSummary(state)}` };
}

export function acInsert(
  state: AcState,
  task: string | undefined,
  position: number | undefined,
): ActionResult {
  if (!task) return { text: "error: task required", isError: true };
  const pos = Math.max(0, Math.min(position ?? 0, state.queue.length));
  state.queue.splice(pos, 0, task);
  return { text: `inserted at ${pos}: ${task}\n${renderSummary(state)}` };
}

export function acPop(state: AcState): ActionResult {
  const removed = state.queue.pop();
  if (state.queue.length === 0) state.enabled = false;
  return { text: removed ? `popped: ${removed}\n${renderSummary(state)}` : "queue empty" };
}

/**
 * Shift front task. In drain mode (onDrain installed) the queue is allowed
 * to empty while staying enabled — the next agent_end fires onDrain to
 * refill. In fifo mode, an empty queue auto-disables the loop.
 */
export function acDone(state: AcState): ActionResult {
  const removed = state.queue.shift();
  if (!removed) return { text: "queue empty" };
  if (state.queue.length === 0 && !state.onDrain) {
    state.enabled = false;
    return { text: `completed: ${removed}\nall tasks done.` };
  }
  return { text: `completed: ${removed}\n${renderSummary(state)}` };
}

/**
 * Enable the loop. Permitted when the queue is non-empty OR an onDrain
 * hook is installed. Rejects an empty queue without a hook since there
 * would be nothing for `agent_end` to inject.
 */
export function acOn(state: AcState): ActionResult {
  if (state.queue.length === 0 && !state.onDrain) {
    return { text: "queue empty — add tasks first", isError: true };
  }
  state.enabled = true;
  return { text: `enabled\n${renderSummary(state)}` };
}

export function acOff(state: AcState): ActionResult {
  state.enabled = false;
  return { text: `disabled\n${renderSummary(state)}` };
}

/**
 * Full reset: empty queue, disable, clear drain hook.
 */
export function acClear(state: AcState): ActionResult {
  state.queue.length = 0;
  state.enabled = false;
  state.onDrain = undefined;
  return { text: "cleared" };
}

// ---------- new actions (v1) ----------

export function acStatus(state: AcState): StatusResult {
  return {
    enabled: state.enabled,
    queueLength: state.queue.length,
    hasDrain: Boolean(state.onDrain),
  };
}

export function acUpdate(
  state: AcState,
  task: string | undefined,
  position: number | undefined,
): ActionResult {
  if (!task) return { text: "error: task required", isError: true };
  if (typeof position !== "number" || !Number.isInteger(position)) {
    return { text: "error: position must be a non-negative integer", isError: true };
  }
  if (position < 0 || position >= state.queue.length) {
    return {
      text: `error: position ${position} out of bounds (queue length ${state.queue.length})`,
      isError: true,
    };
  }
  state.queue[position] = task;
  return { text: `updated ${position}: ${task}\n${renderSummary(state)}` };
}

/**
 * Install a drain-time injection. The stored prompt is re-injected every
 * time the queue empties while enabled, until `undrive` or `clear` is
 * called. Errors if the prompt is empty.
 */
export function acDrive(state: AcState, prompt: string | undefined): ActionResult {
  const trimmed = (prompt ?? "").trim();
  if (!trimmed) return { text: "error: prompt required", isError: true };
  state.onDrain = () => trimmed;
  return { text: `drive installed\n${renderSummary(state)}` };
}

export function acUndrive(state: AcState): ActionResult {
  state.onDrain = undefined;
  return { text: `drive cleared\n${renderSummary(state)}` };
}

// ---------- agent_end evaluation ----------

/**
 * Called on each `agent_end`. Returns a string to inject as the next
 * followUp, or `undefined` to do nothing. Mutates `state.enabled` when
 * the loop should stop (fifo mode drain, or onDrain returning undefined).
 *
 * Both fifo and drive injections are tagged with `[auto-continue]` so
 * they are distinguishable from ordinary user messages in the session
 * transcript. The tag pattern mirrors the existing fifo convention.
 */
export function evaluateAgentEnd(state: AcState): string | undefined {
  if (!state.enabled) return undefined;
  if (state.queue.length > 0) {
    return (
      `[auto-continue] current task\n` +
      `AUTO-CONTINUE TASK:\n` +
      `${state.queue[0]}\n\n` +
      `REQUIRED AFTER COMPLETING THIS TASK: call ac done.\n\n` +
      `CONTROL HINTS (informational; not part of the task): ac off pauses the loop if the human explicitly asks or a stop criterion requires it; ac insert adds tasks.`
    );
  }
  // Queue empty.
  if (!state.onDrain) {
    state.enabled = false;
    return undefined;
  }
  const prompt = state.onDrain();
  if (prompt === undefined) {
    state.enabled = false;
    return undefined;
  }
  return (
    `[auto-continue] drive (queue empty)\n` +
    `SYSTEM-GENERATED FOLLOW-UP, not a direct human request.\n\n` +
    `AUTO-CONTINUE DRIVE TASK:\n` +
    prompt + `\n\n` +
    `CONTROL HINTS (informational; not part of the drive task): do not call ac off or ac undrive just because this hint is shown. Use ac off only if the human explicitly asks to pause or the drive-prompt stop criterion requires it. Use ac undrive only if the human explicitly asks to disable the drive prompt.`
  );
}
