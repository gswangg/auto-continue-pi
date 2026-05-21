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
  /**
   * Crash-loop guard. Counts consecutive turns that ended with
   * stopReason "error". When the count reaches `errorThreshold` the
   * loop disables itself so we don't keep poking a model that's
   * burning quota on failures. A successful turn resets the counter.
   */
  consecutiveErrors: number;
  errorThreshold: number;
};

/** Default crash-loop threshold: number of consecutive errored turns that disables the loop. */
export const DEFAULT_ERROR_THRESHOLD = 5;

export type ActionResult = {
  text: string;
  isError?: boolean;
};

export type StatusResult = {
  enabled: boolean;
  queueLength: number;
  hasDrain: boolean;
};

export function createAcState(opts: { errorThreshold?: number } = {}): AcState {
  return {
    enabled: false,
    queue: [],
    consecutiveErrors: 0,
    errorThreshold: opts.errorThreshold ?? DEFAULT_ERROR_THRESHOLD,
  };
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
  // Explicit re-enable means the user knows what they're doing; clear any
  // previously tripped crash-loop counter so the loop gets a fresh budget.
  state.consecutiveErrors = 0;
  return { text: `enabled\n${renderSummary(state)}` };
}

export function acOff(state: AcState): ActionResult {
  state.enabled = false;
  return { text: `disabled\n${renderSummary(state)}` };
}

/**
 * Full reset: empty queue, disable, clear drain hook, reset error counter.
 */
export function acClear(state: AcState): ActionResult {
  state.queue.length = 0;
  state.enabled = false;
  state.onDrain = undefined;
  state.consecutiveErrors = 0;
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

export type AgentEndOpts = {
  /**
   * True if the assistant turn that just ended had stopReason "error"
   * (model/provider failure). The wrapper derives this from the
   * agent_end event payload.
   */
  errored?: boolean;
};

/**
 * Called on each `agent_end`. Returns a string to inject as the next
 * followUp, or `undefined` to do nothing. Mutates `state.enabled` when
 * the loop should stop (fifo mode drain, onDrain returning undefined,
 * or the crash-loop threshold tripping).
 *
 * Both fifo and drive injections are tagged with `[auto-continue]` so
 * they are distinguishable from ordinary user messages in the session
 * transcript. The tag pattern mirrors the existing fifo convention.
 */
export function evaluateAgentEnd(state: AcState, opts: AgentEndOpts = {}): string | undefined {
  if (!state.enabled) return undefined;

  // Crash-loop guard. Update the counter before deciding whether to poke.
  // We only count errored turns toward the threshold; a single non-errored
  // turn fully resets the count so flaky models don't accumulate forever.
  if (opts.errored) {
    state.consecutiveErrors += 1;
    if (state.consecutiveErrors >= state.errorThreshold) {
      state.enabled = false;
      return undefined;
    }
  } else {
    state.consecutiveErrors = 0;
  }

  if (state.queue.length > 0) {
    return (
      `[auto-continue] current task\n` +
      `AUTO-CONTINUE TASK:\n` +
      `${state.queue[0]}\n\n` +
      `REQUIRED AFTER COMPLETING THIS TASK: call ac done.\n` +
      `Do not pause or stop the loop unless the human explicitly asks or a stop criterion requires it.`
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
    `Do not pause or disable the drive solely because this follow-up appeared. Stop only on an explicit human request or the drive-prompt stop criterion.`
  );
}
