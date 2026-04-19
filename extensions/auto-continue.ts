// pi extension wrapper for the auto-continue task queue.
//
// All state-machine logic lives in core.ts. This file is a thin adapter:
// register the `ac` tool, dispatch to core functions, wire `agent_end`
// to the drain evaluator.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  acClear,
  acDone,
  acDrive,
  acInsert,
  acList,
  acOff,
  acOn,
  acPop,
  acPush,
  acStatus,
  acUndrive,
  acUpdate,
  createAcState,
  evaluateAgentEnd,
  type ActionResult,
} from "./core.js";

function toToolContent(result: ActionResult) {
  return {
    content: [{ type: "text", text: result.text }],
    ...(result.isError ? { isError: true } : {}),
  };
}

export default function (pi: ExtensionAPI) {
  const state = createAcState();

  pi.registerTool({
    name: "ac",
    description: "Auto-continue task queue. Read, modify, and control the task queue.",
    parameters: Type.Object({
      action: StringEnum(
        [
          "list",
          "push",
          "insert",
          "update",
          "pop",
          "done",
          "on",
          "off",
          "clear",
          "status",
          "drive",
          "undrive",
        ] as const,
        {
          description:
            "list: show queue. push: append task. insert: insert task at position (requires 'task' and 'position'). update: replace task at position (requires 'task' and 'position'). pop: remove last. done: complete current (shift front). on: enable (queue preserved). off: pause (queue preserved). clear: empty queue, disable, and clear drain hook. status: return {enabled, queueLength, hasDrain}. drive: install drain-time prompt (requires 'prompt'). undrive: clear drain-time prompt.",
        },
      ),
      task: Type.Optional(Type.String({ description: "Task description (for push/insert/update)." })),
      position: Type.Optional(
        Type.Number({ description: "Queue position (for insert/update). 0 = front." }),
      ),
      prompt: Type.Optional(
        Type.String({
          description:
            "Drain-time injection string (for drive). Injected as a followUp whenever the queue empties while enabled.",
        }),
      ),
    }),
    async execute(...args: unknown[]) {
      for (const a of args) {
        if (a && typeof a === "object" && typeof (a as { action?: unknown }).action === "string") {
          const { action, task, position, prompt } = a as {
            action: string;
            task?: string;
            position?: number;
            prompt?: string;
          };
          switch (action) {
            case "list":
              return toToolContent(acList(state));
            case "push":
              return toToolContent(acPush(state, task));
            case "insert":
              return toToolContent(acInsert(state, task, position));
            case "update":
              return toToolContent(acUpdate(state, task, position));
            case "pop":
              return toToolContent(acPop(state));
            case "done":
              return toToolContent(acDone(state));
            case "on":
              return toToolContent(acOn(state));
            case "off":
              return toToolContent(acOff(state));
            case "clear":
              return toToolContent(acClear(state));
            case "status":
              return {
                content: [{ type: "text", text: JSON.stringify(acStatus(state)) }],
              };
            case "drive":
              return toToolContent(acDrive(state, prompt));
            case "undrive":
              return toToolContent(acUndrive(state));
            default:
              return {
                content: [{ type: "text", text: `unknown action: ${action}` }],
                isError: true,
              };
          }
        }
      }
      return {
        content: [{ type: "text", text: "no valid params" }],
        isError: true,
      };
    },
  });

  // After each agent turn: evaluate drain state and inject followUp if the
  // core tells us to. Core mutates `state.enabled` when the loop should
  // stop; we just wire the string through to pi.sendUserMessage.
  pi.on("agent_end", async () => {
    const text = evaluateAgentEnd(state);
    if (text !== undefined) {
      pi.sendUserMessage(text, { deliverAs: "followUp" });
    }
  });
}
