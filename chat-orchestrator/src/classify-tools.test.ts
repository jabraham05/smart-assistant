import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGroupsToTools, applyBackgroundOverride } from "./classify-tools.js";

test("expandGroupsToTools always includes calculate and task_context_manage", () => {
  assert.deepEqual(new Set(expandGroupsToTools([])), new Set(["calculate", "task_context_manage"]));
});

test("expandGroupsToTools maps a single group to its tools", () => {
  assert.deepEqual(
    new Set(expandGroupsToTools(["media"])),
    new Set(["calculate", "task_context_manage", "spotify_control"]),
  );
});

test("expandGroupsToTools de-duplicates across overlapping groups and ignores unknown ones", () => {
  const tools = expandGroupsToTools(["self-growth", "not-a-real-group"]);
  assert.deepEqual(
    new Set(tools),
    new Set(["calculate", "task_context_manage", "skill_propose", "code_task", "code_task_status", "project_propose"]),
  );
});

test("expandGroupsToTools combines multiple real groups", () => {
  const tools = expandGroupsToTools(["media", "scheduling"]);
  assert.deepEqual(
    new Set(tools),
    new Set(["calculate", "task_context_manage", "spotify_control", "calendar_event"]),
  );
});

test("applyBackgroundOverride is a no-op when background is false", () => {
  const tools = expandGroupsToTools(["media"]);
  assert.deepEqual(applyBackgroundOverride(false, ["media"], tools), { background: false, relevantTools: tools });
});

test("applyBackgroundOverride adds research_task tools when research was classified", () => {
  const tools = expandGroupsToTools(["research"]);
  const result = applyBackgroundOverride(true, ["research"], tools);
  assert.equal(result.background, true);
  assert.ok(result.relevantTools.includes("research_task"));
  assert.ok(result.relevantTools.includes("research_task_status"));
});

test("applyBackgroundOverride adds research_task tools when web was classified", () => {
  const tools = expandGroupsToTools(["web"]);
  const result = applyBackgroundOverride(true, ["web"], tools);
  assert.equal(result.background, true);
  assert.ok(result.relevantTools.includes("research_task"));
});

test("applyBackgroundOverride falls back to false when there's nothing backgroundable to do", () => {
  const tools = expandGroupsToTools(["media"]);
  const result = applyBackgroundOverride(true, ["media"], tools);
  assert.equal(result.background, false);
  assert.deepEqual(result.relevantTools, tools);
});
