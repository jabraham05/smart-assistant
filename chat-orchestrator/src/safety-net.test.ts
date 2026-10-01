import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isConfabulatedAction,
  hasUnfulfilledSearchIntent,
  hasUnsatisfiedRequiredTool,
  classifyMemoryGrounding,
} from "./safety-net.js";

test("isConfabulatedAction flags a claimed action with no matching tool call", () => {
  assert.equal(
    isConfabulatedAction("I've scheduled that for you.", ["calendar_event"], []),
    true,
  );
});

test("isConfabulatedAction does not flag a real action that was actually called", () => {
  assert.equal(
    isConfabulatedAction("I've scheduled that for you.", ["calendar_event"], ["calendar_event"]),
    false,
  );
});

test("isConfabulatedAction does not flag plain text with no action claim", () => {
  assert.equal(isConfabulatedAction("The weather today is sunny.", ["weather_get"], []), false);
});

test("isConfabulatedAction ignores a claim when no action tool was even bound", () => {
  assert.equal(isConfabulatedAction("I've added that.", ["weather_get"], []), false);
});

test("hasUnfulfilledSearchIntent flags narrated intent with no actual search call", () => {
  assert.equal(
    hasUnfulfilledSearchIntent("Let me search for that real quick.", ["web_search"], []),
    true,
  );
});

test("hasUnfulfilledSearchIntent does not flag when the search tool was actually called", () => {
  assert.equal(
    hasUnfulfilledSearchIntent("Let me search for that.", ["web_search"], ["web_search"]),
    false,
  );
});

test("hasUnfulfilledSearchIntent does not flag ordinary text", () => {
  assert.equal(hasUnfulfilledSearchIntent("Here's the answer directly.", ["web_search"], []), false);
});

test("hasUnsatisfiedRequiredTool flags a required policy with no matching call", () => {
  assert.equal(hasUnsatisfiedRequiredTool("required", ["calculate", "task_context_manage", "weather_get"], []), true);
});

test("hasUnsatisfiedRequiredTool does not flag when the capability tool was actually called", () => {
  assert.equal(
    hasUnsatisfiedRequiredTool("required", ["calculate", "weather_get"], ["weather_get"]),
    false,
  );
});

test("hasUnsatisfiedRequiredTool does not flag toolPolicy=optional", () => {
  assert.equal(hasUnsatisfiedRequiredTool("optional", ["weather_get"], []), false);
});

test("hasUnsatisfiedRequiredTool does not flag when only calculate is exposed (no task-creation signal)", () => {
  assert.equal(hasUnsatisfiedRequiredTool("required", ["calculate"], []), false);
});

// Real gap found via live testing: "create a task to do X" has no
// classifier category of its own, so this used to short-circuit to false
// unconditionally - the model could talk about creating a task and never
// actually call task_context_manage, with no backstop at all.
test("hasUnsatisfiedRequiredTool flags task_context_manage bound-but-uncalled even with no other capability tool", () => {
  assert.equal(hasUnsatisfiedRequiredTool("required", ["calculate", "task_context_manage"], []), true);
});

test("hasUnsatisfiedRequiredTool does not flag when task_context_manage was actually called", () => {
  assert.equal(
    hasUnsatisfiedRequiredTool("required", ["calculate", "task_context_manage"], ["task_context_manage"]),
    false,
  );
});

test("hasUnsatisfiedRequiredTool is satisfied if any bound capability tool was called, not necessarily all", () => {
  assert.equal(
    hasUnsatisfiedRequiredTool("required", ["weather_get", "calendar_event"], ["calendar_event"]),
    false,
  );
});

// Real bug found via live testing: "list my open tasks" classified into
// 'goals' (binding goal_manage/status_overview) but was correctly answered
// by task_context_manage instead - a genuine overlap, not a wrong tool
// choice. The successful call still got flagged as unsatisfied and
// overridden with the hardcoded failure message, since task_context_manage
// only ever excused itself when it was the ONLY bound tool at all.
test("hasUnsatisfiedRequiredTool does not flag task_context_manage when 'goals' is a relevant group, even with other goals tools bound", () => {
  assert.equal(
    hasUnsatisfiedRequiredTool(
      "required",
      ["calculate", "task_context_manage", "goal_manage", "status_overview"],
      ["task_context_manage"],
      ["goals"],
    ),
    false,
  );
});

test("hasUnsatisfiedRequiredTool still flags an unrelated group even if task_context_manage was called", () => {
  assert.equal(
    hasUnsatisfiedRequiredTool(
      "required",
      ["calculate", "task_context_manage", "weather_get"],
      ["task_context_manage"],
      ["info"],
    ),
    true,
  );
});

// Real incident that motivated this: an invented, plausible-sounding API
// name written with zero tool calls got stored into memory, then retrieved
// and cited as "confirmed research" in later unrelated conversations.
test("classifyMemoryGrounding always tags a user role as user_stated", () => {
  assert.equal(classifyMemoryGrounding("user", []), "user_stated");
  assert.equal(classifyMemoryGrounding("user", ["web_search"]), "user_stated");
});

test("classifyMemoryGrounding tags an assistant reply with a tool call as tool_verified", () => {
  assert.equal(classifyMemoryGrounding("assistant", ["web_search"]), "tool_verified");
});

test("classifyMemoryGrounding tags an assistant reply with no tool calls as ungrounded", () => {
  assert.equal(classifyMemoryGrounding("assistant", []), "ungrounded");
});
