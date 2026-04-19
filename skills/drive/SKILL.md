---
name: drive
description: Start or resume a long-running autonomous work loop on a task. Use when the user asks to "drive on X", "keep pushing on X", "continue driving Y", or explicitly invokes /skill:drive. The skill wires up the ac auto-continue queue with a drain-time prompt so the agent keeps generating and executing work between turns until OAuth limits, explicit ac off, or external interruption. Not for one-off tasks — only invoke for open-ended ongoing work.
argument-hint: [task-name] [optional seed describing the work]
---

# Drive — Long-running autonomous work loop

This skill sets up or resumes a drive session. A drive is a self-sustaining work loop: the ac queue drains normally, and when empty the extension re-injects a configured prompt that tells the agent to find more work. You use this skill to configure that loop for a specific task and kick it off.

## Step 0: Determine task name

The task name is a short slug (kebab-case) identifying this drive. It becomes a directory name under `~/pi-work/`. Examples: `cleanup`, `refactor-auth`, `notes-digest`, `forward`.

If the user provided it as the argument, use that. Otherwise ask them.

## Step 1: Check for an existing drive-prompt

```
~/pi-work/<task-name>/drive-prompt.md
```

- **If it exists**, this is a resume. Go to Step 3.
- **If it does not exist**, this is a new drive. Go to Step 2.

## Step 2: Construct drive-prompt.md (new drive only)

Gather enough context from the user (or the provided seed) to write a useful drive-prompt.md. The quality of this file determines the quality of the drive loop — budget a real conversation with the user, not a token interview.

Ask the user (in prose, not a checklist) about:

- **Goal** — what should be true when this drive is "done"? Can be open-ended ("keep pushing the project forward") but should be meaningful.
- **Rules** — what must the agent avoid? Typical: never commit to main, work on branches named `drive/<slug>/<ts>`, never force-push, stay within a given directory, avoid destructive bash.
- **Find-work instructions** — concretely, when the queue empties, what should the agent look at? "Read backlog.md and pick the top item" vs "Scan `git log` and propose 1-3 tasks" vs "Read the latest journal entry and continue from there" — these produce very different behavior.
- **Journaling convention** — where should the agent record what it did? Default: append to `~/pi-work/<task-name>/journal.jsonl` with one JSON object per completed task (timestamp, task, outcome, commit SHAs if applicable).
- **Stop criterion** — when should the agent call `ac off`? Open-ended loops bite OAuth limits eventually; a clean criterion (e.g., "when the backlog file has no pending items" or "after 10 completed tasks") is better.

Then write `~/pi-work/<task-name>/drive-prompt.md` with this recommended structure:

```markdown
# Drive prompt: <task-name>

## Goal

<what this drive is trying to accomplish>

## Rules

- <rule 1>
- <rule 2>
...

## Find-work (executed each time the queue empties)

<concrete instructions: read this, scan that, pick the next item, ac.push it>

If you cannot find concrete work to do, call `ac off` and stop.

## Journaling

After completing each task, append a JSON object to `~/pi-work/<task-name>/journal.jsonl`:

```json
{"ts":"<iso>","task":"<the task>","outcome":"<brief>","commits":["<sha>", ...]}
```

## Stop criterion

<when should `ac off` be called>
```

Create the working directory if it doesn't exist. You can also seed the initial queue here by calling `ac push` with 1–3 concrete starter items if you know them.

## Step 3: Wire up ac and enable the loop

Whether resuming or starting new, the wiring is the same:

1. Call `ac drive` with this exact string:
   ```
   Read and execute ~/pi-work/<task-name>/drive-prompt.md.
   ```
   (Replace `<task-name>` with the actual task name.)
2. Call `ac on`.

That's it. The extension will inject the "Read and execute …" string as a followUp every time the ac queue empties while enabled. On each drain, the agent re-reads `drive-prompt.md` (fresh each time — it can be edited externally between cycles) and follows the instructions there.

## Step 4: Acknowledge to the user

Briefly confirm:

- Which task is being driven.
- Whether it was new or resumed.
- The working directory path.
- How to pause (`ac off` or tell the agent to pause).
- How to inspect progress (`ac list` or `tail -f ~/pi-work/<task-name>/journal.jsonl`).

## Guidelines

- **Do not invoke drive for one-off tasks.** If the user asks you to do something concrete and bounded, just do it. Drive is for ongoing, self-sustaining work.
- **Re-read drive-prompt.md on each drain.** Do not cache its content in conversation memory. The file can change between cycles and you want the fresh version.
- **Edits to drive-prompt.md are allowed and encouraged.** If during a drive you realize the rules should be updated, write the change to the file and it applies to the next cycle.
- **The working directory is yours.** drive-prompt.md prescribes what else lives there (journal, artifacts, backlog). The extension itself only cares about `ac drive` / `ac on` / `ac done`.
