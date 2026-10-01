import { test } from "node:test";
import assert from "node:assert/strict";
import { isRetryEvent, reduceMessage } from "./message-reducer.js";
import type { ChatMessage, N8nStreamEvent } from "@/types/chat";

function emptyMessage(): ChatMessage {
  return { id: "assistant-1", role: "assistant", content: "", steps: [], rawEvents: [], trace: [] };
}

function itemEvent(content: string): N8nStreamEvent {
  return {
    type: "item",
    content,
    metadata: { nodeId: "agent-service", nodeName: "AI Agent", itemIndex: 0, runIndex: 0, timestamp: Date.now() },
  };
}

function retryEvent(reason: N8nStreamEvent["trace"] extends { reason: infer R } ? R : never): N8nStreamEvent {
  return {
    type: "trace",
    trace: { kind: "retry", attempt: 2, reason },
    metadata: { nodeId: "agent-service", nodeName: "AI Agent", itemIndex: 0, runIndex: 0, timestamp: Date.now() },
  };
}

test("reduceMessage appends item content to a growing reply", () => {
  let m = emptyMessage();
  m = reduceMessage(m, itemEvent("Hello"), new Map());
  m = reduceMessage(m, itemEvent(" world"), new Map());
  assert.equal(m.content, "Hello world");
});

test("reduceMessage resets content to empty on a retry trace event", () => {
  let m = emptyMessage();
  m = reduceMessage(m, itemEvent("this is a bad draft"), new Map());
  assert.equal(m.content, "this is a bad draft");
  m = reduceMessage(m, retryEvent("fabricated_id"), new Map());
  assert.equal(m.content, "", "content should be cleared, not kept around for the retry to append onto");
});

// The exact real bug, reproduced end to end: a first attempt streams real
// text, agent-service's safety net fires a retry, and the retry streams its
// own (different, correct) text - the final content must be ONLY the
// retry's text, never the two concatenated.
test("a retry's text never gets concatenated after the discarded first attempt's text", () => {
  const openSteps = new Map<string, number>();
  let m = emptyMessage();
  m = reduceMessage(m, itemEvent("Task #19 is still active"), openSteps);
  m = reduceMessage(m, itemEvent(" and task #54 is running."), openSteps);
  m = reduceMessage(m, retryEvent("fabricated_id"), openSteps);
  m = reduceMessage(m, itemEvent("Let me check that properly."), openSteps);
  m = reduceMessage(m, itemEvent(" Task #54 is running, per status_overview."), openSteps);

  assert.equal(m.content, "Let me check that properly. Task #54 is running, per status_overview.");
  assert.doesNotMatch(m.content, /still active/, "the discarded first attempt's text must not survive the retry");
});

test("reduceMessage keeps trace/step history across a retry, only content resets", () => {
  const openSteps = new Map<string, number>();
  let m = emptyMessage();
  m = reduceMessage(
    m,
    {
      type: "trace",
      trace: { kind: "tool_call", attempt: 1, iteration: 1, name: "task_context_manage", args: {} },
      metadata: { nodeId: "x", nodeName: "AI Agent", itemIndex: 0, runIndex: 0, timestamp: 1 },
    },
    openSteps,
  );
  m = reduceMessage(m, itemEvent("draft"), openSteps);
  m = reduceMessage(m, retryEvent("fabricated_id"), openSteps);

  assert.equal(m.content, "");
  assert.equal(m.steps?.length, 1, "tool-call step history should survive the retry, unlike content");
  assert.equal(m.trace?.length, 2, "trace history (tool_call + retry) should survive the retry");
});

test("tool_call then matching tool_result closes out the step as done", () => {
  const openSteps = new Map<string, number>();
  let m = emptyMessage();
  m = reduceMessage(
    m,
    {
      type: "trace",
      trace: { kind: "tool_call", attempt: 1, iteration: 1, name: "status_overview", args: {} },
      metadata: { nodeId: "x", nodeName: "AI Agent", itemIndex: 0, runIndex: 0, timestamp: 1 },
    },
    openSteps,
  );
  m = reduceMessage(
    m,
    {
      type: "trace",
      trace: { kind: "tool_result", attempt: 1, iteration: 1, name: "status_overview", result: "ok", isError: false },
      metadata: { nodeId: "x", nodeName: "AI Agent", itemIndex: 0, runIndex: 0, timestamp: 2 },
    },
    openSteps,
  );
  assert.equal(m.steps?.[0]?.status, "done");
});

test("isRetryEvent only matches a trace event whose kind is retry", () => {
  assert.equal(isRetryEvent(retryEvent("empty_output")), true);
  assert.equal(isRetryEvent(itemEvent("hello")), false);
  assert.equal(
    isRetryEvent({
      type: "trace",
      trace: { kind: "tool_call", attempt: 1, iteration: 1, name: "x", args: {} },
      metadata: { nodeId: "x", nodeName: "AI Agent", itemIndex: 0, runIndex: 0, timestamp: 1 },
    }),
    false,
  );
});
