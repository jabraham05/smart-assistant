import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./classify.js";

test("classify: known (source, type) pairs return their configured rule", () => {
  assert.deepEqual(classify("coding_orchestrator", "task_completed"), { priority: "normal", notify: false });
  assert.deepEqual(classify("coding_orchestrator", "task_resource_limit"), { priority: "high", notify: false });
  assert.deepEqual(classify("coding_orchestrator", "task_needs_review"), { priority: "high", notify: false });
  assert.deepEqual(classify("discord", "dm_received"), { priority: "normal", notify: false });
  assert.deepEqual(classify("pi_dashboard", "control_changed"), { priority: "low", notify: false });
  assert.deepEqual(classify("home_assistant", "arrived_home"), { priority: "low", notify: false });
  assert.deepEqual(classify("home_assistant", "left_home"), { priority: "low", notify: false });
  assert.deepEqual(classify("google_calendar", "event_detected"), { priority: "low", notify: false });
  assert.deepEqual(classify("google_calendar", "event_starting_soon"), { priority: "high", notify: false });
  assert.deepEqual(classify("idle_reflection", "proactive_thought"), { priority: "high", notify: false });
  assert.deepEqual(classify("task_context", "task_context_created"), { priority: "low", notify: false });
  assert.deepEqual(classify("task_context", "task_context_updated"), { priority: "low", notify: false });
  assert.deepEqual(classify("project", "project_created"), { priority: "low", notify: false });
  assert.deepEqual(classify("research", "research_completed"), { priority: "low", notify: false });
});

test("classify: unrecognized (source, type) falls back to DEFAULT, not rejected", () => {
  assert.deepEqual(classify("some_new_source", "some_new_type"), { priority: "normal", notify: false });
});

test("classify: a known source with an unrecognized type also falls back to DEFAULT", () => {
  assert.deepEqual(classify("home_assistant", "left_the_country"), { priority: "normal", notify: false });
});

test("classify: is an exact (source, type) lookup, not a source-only or type-only match", () => {
  // Same type as a real rule, unrelated source - must not match on type alone.
  assert.deepEqual(classify("some_other_source", "arrived_home"), { priority: "normal", notify: false });
  // Same source as a real rule, unrelated type - must not match on source alone.
  assert.deepEqual(classify("home_assistant", "task_completed"), { priority: "normal", notify: false });
});

test("classify: every rule that defaults to notify:false stays that way (no accidental firehose)", () => {
  const sourceTypePairs: [string, string][] = [
    ["coding_orchestrator", "task_completed"],
    ["coding_orchestrator", "task_resource_limit"],
    ["coding_orchestrator", "task_needs_review"],
    ["discord", "dm_received"],
    ["pi_dashboard", "control_changed"],
    ["home_assistant", "arrived_home"],
    ["home_assistant", "left_home"],
    ["google_calendar", "event_detected"],
    ["google_calendar", "event_starting_soon"],
    ["idle_reflection", "proactive_thought"],
    ["task_context", "task_context_created"],
    ["task_context", "task_context_updated"],
    ["project", "project_created"],
    ["research", "research_completed"],
  ];
  for (const [source, type] of sourceTypePairs) {
    assert.equal(classify(source, type).notify, false, `${source}.${type} should default to notify:false`);
  }
});
