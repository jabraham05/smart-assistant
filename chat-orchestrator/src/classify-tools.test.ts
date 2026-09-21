import { test } from "node:test";
import assert from "node:assert/strict";
import { expandGroupsToTools } from "./classify-tools.js";

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
    new Set(["calculate", "task_context_manage", "skill_propose", "code_task", "code_task_status"]),
  );
});

test("expandGroupsToTools combines multiple real groups", () => {
  const tools = expandGroupsToTools(["media", "scheduling"]);
  assert.deepEqual(
    new Set(tools),
    new Set(["calculate", "task_context_manage", "spotify_control", "calendar_event"]),
  );
});
