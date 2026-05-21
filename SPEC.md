# auto-continue-pi — Specification

Status: draft (Phase 0, revised)
Package: `gswangg/auto-continue-pi`
Replaces: `~/.pi/agent/extensions/auto-continue.ts` (loose file, pre-package)

## Purpose

A pi extension that provides a per-session task queue with auto-continuation between turns (`ac`) plus a pair of primitives (`ac drive` / `ac undrive`) that let the agent install a drain-time prompt. A companion skill (`drive`) contains the orchestration logic for long-running autonomous work — the extension itself stays workflow-agnostic.

Two supported use cases:

1. **Batch execution.** User or agent queues N tasks; agent drains them one per turn. Unchanged behavior from the current auto-continue extension.
2. **Long-running autonomous work.** Agent invokes the `drive` skill, which constructs or resumes a drive-prompt file and wires up `ac` so the queue refills when empty via an agent-provided injection string.

The extension does not own scheduling, filesystem conventions, or drive-session state beyond the single `onDrain` injection string. All orchestration logic lives in the skill body and the agent's reasoning.

## Design philosophy

**Primitives, not workflows.** The extension provides a small set of composable primitives. The agent (via skills + reasoning) decides how to use them. This keeps the extension small, testable, and free of policy.

**Agent owns orchestration.** Filesystem layout, drive-prompt structure, journaling conventions, stop criteria — all live in the drive skill body or in user-authored drive-prompt files. The extension never reads, parses, writes, or validates any file.

**Minimal state.** One closure-local object; three fields total.

## Non-goals (explicitly deferred)

- **`onDone` hook.** Journaling and backlog mirroring are agent responsibilities, prescribed in the drive-prompt file, not enforced by the extension.
- **Compaction preservation.** Config and journal are re-readable from disk; summary + duncan + journal are enough recovery paths. Revisit only if observed to fail.
- **Multi-session lock.** Adds complexity for a failure mode that has not been observed. Revisit if two pi sessions in the same working dir cause problems.
- **Fruitless-round counter.** OAuth limits + `ac off` + external SIGTERM cover termination. Add if loops on emptiness become real. (Distinct from the crash-loop guard below — fruitless rounds are productive-looking turns that fail to make progress; crash-loop turns are model/provider errors.)
- **Internal time-window stop.** External scheduling handles start time; external SIGTERM handles stop time. No reason for the extension to duplicate wall-clock gating.
- **`/loop` (timer-based recurring prompts).** Different machinery (wall-clock timer, not queue-drain). Future package.
- **Durable persistence of ac state across pi restarts.** Queue and onDrain are in-memory. Re-invoking `/skill:drive <task-name>` after restart re-seeds both from the drive-prompt file.
- **Extension-provided slash commands of any kind.** Neither `/ac` nor `/drive`. `/skill:drive` is pi-native and sufficient for explicit drive invocation. All queue operations happen through the agent calling the `ac` tool.
- **Filesystem layout enforcement.** The extension does not know or care where drive-prompt files live. The drive skill body recommends `~/pi-work/<task-name>/drive-prompt.md` as a convention, but the extension accepts any string the agent passes to `ac drive`.

## Agent-facing tool surface

Tool name: `ac`. Single tool, multiple actions.

```
action: "list" | "push" | "insert" | "update" | "pop" | "done" | "on" | "off" | "clear" | "status" | "drive" | "undrive"
task?: string          // for push/insert/update
position?: number      // for insert (0 = front) / update
prompt?: string        // for drive
```

### Existing actions (unchanged)

| Action  | Behavior                                                                                      |
|---------|-----------------------------------------------------------------------------------------------|
| list    | Return queue and enabled state                                                                |
| push    | Append task to queue                                                                          |
| insert  | Insert task at position (clamped to `[0, queue.length]`)                                      |
| pop     | Remove last task; auto-disable if queue becomes empty                                         |
| off     | Disable (queue preserved)                                                                     |
| clear   | Empty queue, disable, and clear `onDrain` (full reset)                                        |

### Existing actions with modified semantics (drain-hook support)

| Action  | New behavior                                                                                  |
|---------|-----------------------------------------------------------------------------------------------|
| done    | Shift front task. Auto-disable on empty queue only if `onDrain` is NOT installed.             |
| on      | Enable. Permitted on empty queue if `onDrain` is installed (previously errored).              |

### New actions

| Action   | Parameters                     | Behavior                                                              |
|----------|--------------------------------|-----------------------------------------------------------------------|
| status   | —                              | Return `{ enabled: bool, queueLength: number, hasDrain: bool }`       |
| update   | `position: number`, `task: string` | Replace queue entry at position (0-indexed); errors if out of bounds  |
| drive    | `prompt: string`               | Install `onDrain = () => prompt`. Errors if prompt is empty.          |
| undrive  | —                              | Clear `onDrain`                                                        |

### `agent_end` handler

```typescript
if (!state.enabled) return

// Crash-loop guard. The wrapper inspects the run's last assistant
// message and sets `errored` when stopReason === "error".
if (errored) {
  state.consecutiveErrors += 1
  if (state.consecutiveErrors >= state.errorThreshold) {
    state.enabled = false
    return // ui.notify fires in the wrapper
  }
} else {
  state.consecutiveErrors = 0
}

if (state.queue.length > 0) {
  sendUserMessage(
    `[auto-continue] current task\n` +
    `AUTO-CONTINUE TASK:\n${state.queue[0]}\n\n` +
    `REQUIRED AFTER COMPLETING THIS TASK: call ac done.\n` +
    `Do not pause or stop the loop unless the human explicitly asks or a stop criterion requires it.`,
    { deliverAs: "followUp" }
  )
  return
}
// Queue is empty.
if (!state.onDrain) {
  state.enabled = false
  return
}
const prompt = state.onDrain()
if (prompt === undefined) {
  state.enabled = false
  return
}
sendUserMessage(
  `[auto-continue] drive (queue empty)\n` +
  `SYSTEM-GENERATED FOLLOW-UP, not a direct human request.\n\n` +
  `AUTO-CONTINUE DRIVE TASK:\n${prompt}\n\n` +
  `Do not pause or disable the drive solely because this follow-up appeared. Stop only on an explicit human request or the drive-prompt stop criterion.`,
  { deliverAs: "followUp" }
)
// enabled stays true; next agent_end re-evaluates
```

### Crash-loop guard

The loop disables itself after `errorThreshold` (default 5) consecutive
turns whose last assistant message has `stopReason === "error"`. A
single non-errored turn fully resets the counter. The wrapper notifies
the user via `ctx.ui.notify` when the threshold trips, and `ac on` (or
`ac clear`) clears the counter so the loop gets a fresh budget on resume.

The goal is narrow: prevent a flaky model or provider outage from
burning quota by re-poking the agent endlessly. It does not gate on
user aborts (`stopReason === "aborted"`) or on "unproductive" turns —
those are different concerns.

## User-facing slash commands

None.

The extension registers no slash commands. All queue operations go through the `ac` tool invoked by the agent. Users interact by telling the agent what they want ("queue these tasks", "pause the queue", "show me what's queued"); the agent calls the appropriate `ac` action.

Explicit drive invocation uses pi-native `/skill:drive`.

## drive skill

Located at `skills/drive/SKILL.md` in the package.

### Metadata

- `name: drive`
- `description`: Start or resume a long-running autonomous work loop.
- `whenToUse`: Invoked on phrases like "drive on X", "keep pushing on X", "continue the Y drive", or when the user explicitly runs `/skill:drive`.

### Body (agent instructions)

The skill body instructs the LLM to:

1. **Determine the task name.** If unclear from context, ask the user.
2. **Check for an existing drive-prompt file** at `~/pi-work/<task-name>/drive-prompt.md`.
3. **If it exists** (resuming):
   - Call `ac drive "Read and execute ~/pi-work/<task-name>/drive-prompt.md."` (or a string equivalent that tells the agent to re-read the file each drain).
   - Call `ac on`.
   - Acknowledge to the user that the drive resumed.
4. **If it does not exist** (new drive):
   - Gather task context. Ask the user for: goal, rules/constraints, find-work instructions, journaling convention, stop criterion. Use provided seed if any.
   - Construct `~/pi-work/<task-name>/drive-prompt.md` with these sections:
     - Goal
     - Rules (branches, scope, tool restrictions, never-force-push, etc. as applicable)
     - Find-work (what to do on each drain: read X, scan Y, pick Z)
     - Journaling (append to `~/pi-work/<task-name>/journal.jsonl` after each task with outcome + commit shas + notes)
     - Stop criterion (call `ac off` when condition met)
   - Optionally push initial items via `ac push` if the task has obvious starters.
   - Call `ac drive "Read and execute ~/pi-work/<task-name>/drive-prompt.md."`.
   - Call `ac on`.

### Drive-prompt.md conventions

The skill body includes a recommended template for drive-prompt.md. Users and agents may deviate. The extension never enforces the template.

### Working directory convention (recommended, not enforced)

```
~/pi-work/<task-name>/
  drive-prompt.md    # rich find-work instructions (read by agent each drain)
  journal.jsonl      # append-only log (agent-written)
  artifacts/         # optional outputs
```

Only `drive-prompt.md` is meaningful to the drive skill. Other files are agent convention, prescribed in drive-prompt.md.

## State model

```typescript
type AcState = {
  enabled: boolean
  queue: string[]
  onDrain?: () => string | undefined
  consecutiveErrors: number  // crash-loop counter
  errorThreshold: number     // default 5
}
```

Single extension closure, no exports, no persistence. Re-invoking `/skill:drive <task-name>` after a pi restart re-seeds `onDrain` from the drive-prompt file.

## Test plan

### Regression (existing tool-action behavior, must stay green)

- push/insert/pop/done actions mutate the queue correctly
- `ac on` errors when queue is empty and no `onDrain` is installed
- `ac on` enables successfully when queue has items
- `ac off` preserves queue
- `ac clear` empties the queue, disables, and clears `onDrain`
- `agent_end` injects followUp with queue[0] when enabled and non-empty
- `agent_end` does nothing when disabled
- `agent_end` auto-disables when queue empties in fifo mode (no onDrain)

### New behavior (TDD target)

- **status action**: returns `{ enabled, queueLength, hasDrain }` correctly reflecting state
- **drive action**: installs onDrain that returns the given prompt; errors if prompt is empty
- **undrive action**: clears onDrain
- **on with onDrain**: permitted on empty queue when onDrain is installed
- **done with onDrain**: does not auto-disable on empty queue
- **agent_end with onDrain, empty queue**: injects the stored prompt as followUp, stays enabled, marks it as extension-generated, and does not include pause/undrive tool commands in the repeated followUp
- **drive replaces previous drive**: calling `ac drive` twice replaces onDrain with the new prompt
- **clear also undrives**: `ac clear` clears queue AND removes onDrain

### Crash-loop guard

- **errored turns increment** the counter; non-errored turns reset it to 0
- **reaching the threshold** disables the loop and returns no followUp
- **subsequent agent_ends** after a trip are no-ops while disabled
- **`ac on` after a trip** clears the counter so the loop resumes with a fresh budget
- **`ac clear`** resets the counter along with queue/enabled/onDrain
- **drive mode** is subject to the same guard

### Drive skill (integration, manual QA in v1)

- Invoking `/skill:drive cleanup` when file exists → ac wired to existing prompt, enabled
- Invoking `/skill:drive cleanup` when file missing → agent interviews, creates file, wires up, enables
- Skill body renders cleanly in pi's skill expansion

Full skill-behavior test harness is deferred; rely on Phase 6 dogfood for validation.

## Implementation notes

- Single file: `extensions/auto-continue.ts`, replaces current loose file.
- Package structure follows pi-mono packages.md conventions: `package.json` with `pi.extensions` and `pi.skills`, keywords `["pi-package"]`.
- **Fork-agnostic.** Peer-dep Mario's upstream package names (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@sinclair/typebox`) with `"*"` range. The package works with any pi install that provides these modules — vanilla upstream, Greg's fork, or any other downstream fork that keeps the package name stable.
- **Public, MIT-licensed, publishable to npm.** Repo is public (`gh repo create --public`). License MIT. Package name scoped `@gswangg/auto-continue-pi` matching `@gswangg/duncan-pi` precedent. Repo slug unscoped `gswangg/auto-continue-pi`.
- Test harness: TBD in Phase 2 — either vitest with ExtensionAPI mocks, or an in-process harness if pi exposes one.

## Open questions

1. **Test harness.** Does pi expose test utilities for extensions, or do we mock ExtensionAPI? To be determined in Phase 2.
