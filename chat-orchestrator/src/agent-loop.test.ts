import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateToolResult, trimHistoryToBudget } from "./agent-loop.js";
import type { OllamaMessage } from "./ollama.js";

test("truncateToolResult leaves short text untouched", () => {
  assert.equal(truncateToolResult("hello"), "hello");
});

test("truncateToolResult keeps head and tail on long text", () => {
  const text = "A".repeat(3000) + "ERROR" + "B".repeat(3000);
  const result = truncateToolResult(text, 100);
  assert.ok(result.includes("truncated"));
  assert.ok(result.startsWith("A"));
  assert.ok(result.endsWith("B"));
  assert.ok(result.length < text.length);
});

test("trimHistoryToBudget is a no-op under budget", () => {
  const messages: OllamaMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
  ];
  assert.deepEqual(trimHistoryToBudget(messages, 16384, 2), messages);
});

test("trimHistoryToBudget protects the head and drops whole tool exchanges", () => {
  const big = "x".repeat(5000);
  const messages: OllamaMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "the real question" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "t", arguments: {} } }] },
    { role: "tool", content: big },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "t", arguments: {} } }] },
    { role: "tool", content: "small recent result" },
  ];
  const result = trimHistoryToBudget(messages, 500, 2);
  assert.equal(result[0].content, "sys");
  assert.equal(result[1].content, "the real question");
  assert.ok(result.some((m) => m.content.includes("omitted to stay within context")));
  // The oldest, biggest exchange should be the one dropped, keeping the
  // most recent tool result available.
  assert.ok(result.some((m) => m.content === "small recent result"));
  assert.ok(!result.some((m) => m.content === big));
});

test("trimHistoryToBudget never drops a dangling tool message without its assistant call", () => {
  const big = "x".repeat(5000);
  const messages: OllamaMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "q" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "t", arguments: {} } }] },
    { role: "tool", content: big },
    { role: "tool", content: big },
  ];
  const result = trimHistoryToBudget(messages, 500, 2);
  // Either both tool results from that exchange survive, or neither does -
  // never a lone "tool" message with no assistant call in front of it.
  const firstNonHead = result[2];
  assert.ok(firstNonHead === undefined || firstNonHead.role !== "tool");
});
