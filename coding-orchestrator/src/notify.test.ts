import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSummary } from "./notify.js";
import type { CodingTaskRow } from "./db.js";

function taskRow(overrides: Partial<CodingTaskRow>): CodingTaskRow {
  return {
    id: 1,
    task_description: "Build a thing",
    target_repo_url: null,
    target_ref: "main",
    test_command: null,
    fallback_repo_url: null,
    project_folder: "build-a-thing-123",
    origin_session_id: "session-1",
    status: "proposed",
    latest_status: "Done",
    attempt_count: 1,
    container_id: null,
    diff: null,
    test_output: null,
    reviewer_verdict: "approve",
    reviewer_reason: null,
    pr_url: "https://github.com/example/repo/pull/1",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("buildSummary says 'Finished' for a full approval", () => {
  const summary = buildSummary(taskRow({ reviewer_verdict: "approve" }));
  assert.match(summary, /^Finished:/);
  assert.doesNotMatch(summary, /reduced-scope/);
});

test("buildSummary honestly discloses a partial approval's limitations, not 'Finished'", () => {
  const summary = buildSummary(
    taskRow({
      reviewer_verdict: "approve_partial",
      reviewer_reason: "Single broadcaster only, no speaker diarization, ~5-8s latency not the requested 2.3s.",
    }),
  );
  assert.doesNotMatch(summary, /^Finished:/);
  assert.match(summary, /reduced-scope/);
  assert.match(summary, /Single broadcaster only, no speaker diarization/);
  assert.match(summary, /pull request is ready for review/);
});

test("buildSummary still mentions the PR link for a partial approval", () => {
  const summary = buildSummary(
    taskRow({ reviewer_verdict: "approve_partial", reviewer_reason: "Reduced scope.", pr_url: "https://example.com/pr/9" }),
  );
  assert.match(summary, /https:\/\/example\.com\/pr\/9/);
});
