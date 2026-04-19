# auto-continue-pi

Auto-continuation task queue + drive skill for [pi](https://github.com/badlogic/pi-mono). Two modes of use:

1. **Batch execution** — queue N tasks, the agent drains them one per turn.
2. **Long-running autonomous work** (`/skill:drive`) — the agent drives itself on a task, generating and executing work over extended periods. Useful for overnight cleanup, ongoing project maintenance, or anything you want the agent to chip away at independently.

Fork-agnostic: peer-deps on upstream `@mariozechner/pi-coding-agent` so this works with vanilla pi, Greg's fork, or any other downstream fork that keeps the package name stable.

## What it does

**`ac` tool** — a per-session FIFO queue with auto-continuation. On each `agent_end`, if the queue has items the extension injects the front task as a `followUp` user message so the agent keeps working between turns without human prompting. Actions:

| Action   | Behavior |
|----------|----------|
| `list`   | Show queue + enabled state |
| `push`   | Append task |
| `insert` | Insert task at position |
| `update` | Replace task at position |
| `pop`    | Remove last task |
| `done`   | Shift front task (completion) |
| `on`     | Enable the loop |
| `off`    | Pause the loop (queue preserved) |
| `clear`  | Empty queue + disable + clear drain hook |
| `status` | Inspect `{ enabled, queueLength, hasDrain }` |
| `drive`  | Install drain-time prompt |
| `undrive`| Clear drain-time prompt |

The extension registers no slash commands. All queue operations go through the tool; the agent mediates (tell it "queue these tasks" or "pause the queue" and it handles the calls).

**`drive` skill** (`/skill:drive <task-name>`) — orchestration for long-running work. On invocation:

- If `~/pi-work/<task-name>/drive-prompt.md` exists, the skill wires up `ac` to inject "Read and execute \<path\>." on each drain and enables the loop. Drive resumes.
- If the file doesn't exist, the skill interviews the user (or uses a provided seed) to construct the drive-prompt file with goal, rules, find-work instructions, journaling convention, and stop criterion, then wires up `ac` the same way. Drive starts.

The drive-prompt file is the agent's durable brief — re-read on every drain, survives compaction, externally editable. The extension itself is file-agnostic; the filesystem convention lives entirely in the skill body.

## Install

```bash
pi install git:github.com/gswangg/auto-continue-pi
```

Or, for local development, symlink:

```bash
ln -sf /path/to/auto-continue-pi/extensions/auto-continue.ts ~/.pi/agent/extensions/auto-continue.ts
```

## Design

See [SPEC.md](./SPEC.md) for the full design document, state model, action semantics, test plan, and non-goals.

