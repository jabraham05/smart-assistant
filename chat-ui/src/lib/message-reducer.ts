import type { ChatMessage, N8nStreamEvent } from "@/types/chat";
import { classifyTool } from "@/lib/step-classifier";

// Pure per-event reducer, extracted out of useChat.ts's sendMessage closure
// specifically so it's testable on its own (no React, no DOM) - this logic
// has already had one real bug (retry text concatenation) ship silently
// because nothing exercised it outside a live browser session.
//
// openSteps tracks which step index is currently "open" (running) for a
// given tool call, keyed by attempt:iteration:name, so its matching
// tool_result (not a later call to the same tool) closes it out - mutated
// in place across a whole turn's events, same as when this lived inline.
export function reduceMessage(m: ChatMessage, event: N8nStreamEvent, openSteps: Map<string, number>): ChatMessage {
  const steps = [...(m.steps ?? [])];
  const rawEvents = [...(m.rawEvents ?? []), event];
  const { nodeId, nodeName, timestamp } = event.metadata;

  if (event.type === "item" || event.type === "ack") {
    // AI Agent's streamed tokens are the actual reply text - "ack" is a
    // deterministic, server-emitted acknowledgment for a slow turn (see
    // types/chat.ts), rendered the same way: the leading sentence(s) of
    // the same growing reply, no separate UI needed.
    if (nodeName === "AI Agent" && event.content) {
      return { ...m, content: m.content + event.content, rawEvents };
    }
    return { ...m, rawEvents };
  }

  if (event.type === "trace" && event.trace) {
    const trace = [...(m.trace ?? []), event.trace];

    // Real bug found live: the backend's own retry nudge (empty output,
    // confabulation, fabricated_id, etc.) discards the prior attempt's
    // text server-side (agent-service's main.py only ever keeps the
    // retry's final_text) - but it had already streamed that attempt's
    // "item" events to this client first, and nothing told the client to
    // stop treating them as part of the same growing reply. Without this,
    // a retry's own tokens just get appended after the discarded
    // attempt's, rendering as one garbled double-reply with no visible
    // separator - reproduced live via a direct /api/chat call that
    // triggered a real fabricated_id retry.
    if (event.trace.kind === "retry") {
      return { ...m, steps, rawEvents, trace, content: "" };
    }

    if (event.trace.kind === "tool_call") {
      const { attempt, iteration, name } = event.trace;
      const key = `${attempt}:${iteration}:${name}`;
      const { kind, label } = classifyTool(name);
      openSteps.set(key, steps.length);
      steps.push({
        nodeId: key,
        nodeName: name,
        kind,
        label,
        status: "running",
        startedAt: timestamp,
      });
    }

    if (event.trace.kind === "tool_result") {
      const { attempt, iteration, name, isError } = event.trace;
      const key = `${attempt}:${iteration}:${name}`;
      const idx = openSteps.get(key);
      if (idx !== undefined && steps[idx]) {
        steps[idx] = { ...steps[idx], status: isError ? "error" : "done", finishedAt: timestamp };
        openSteps.delete(key);
      }
    }

    return { ...m, steps, rawEvents, trace };
  }

  if (event.type === "error") {
    steps.push({
      nodeId,
      nodeName,
      kind: "other",
      label: "Something went wrong",
      status: "error",
      startedAt: timestamp,
      finishedAt: timestamp,
    });
    return { ...m, steps, rawEvents };
  }

  return { ...m, rawEvents };
}

// True when an event is the retry trace that reduceMessage above resets
// content on - useChat.ts needs the exact same condition to also reset its
// own accumulatedContent tracker, which lives outside reduceMessage (kept
// pure) for the end-of-stream blank-message check.
export function isRetryEvent(event: N8nStreamEvent): boolean {
  return event.type === "trace" && event.trace?.kind === "retry";
}
