// coding-orchestrator had zero test coverage before this - the deterministic
// review-override helpers in pipeline.ts (findMockLanguageMarkers,
// findOrphanedTestFiles) exist specifically to catch confabulation the LLM
// Reviewer missed, so they need real coverage more than most code here,
// not less. Same node:test convention skills-mcp already uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { advanceAttemptLoop, findMockLanguageMarkers, findOrphanedTestFiles, isApproved } from "./pipeline.js";
import type { AttemptLoopState } from "./pipeline.js";

const LOOP_CONFIG = { maxAttempts: 3, maxInfraRetries: 2 };

function diffFor(files: string[]): string {
  return files.map((f) => `+++ b/${f}\n@@ -0,0 +1,3 @@\n+// content`).join("\n");
}

test("findOrphanedTestFiles flags a test whose implied implementation file the Coder never touched (the real fake-translation-app bug)", () => {
  const coderDiff = diffFor(["pages/index.js"]);
  const fullDiff = diffFor(["pages/index.js", "lib/utils.js", "lib/utils.test.js", "package.json"]);
  assert.deepEqual(findOrphanedTestFiles(fullDiff, coderDiff), ["lib/utils.test.js"]);
});

test("findOrphanedTestFiles does not flag a test that matches a file the Coder actually touched", () => {
  const coderDiff = diffFor(["lib/translate.js"]);
  const fullDiff = diffFor(["lib/translate.js", "lib/translate.test.js"]);
  assert.deepEqual(findOrphanedTestFiles(fullDiff, coderDiff), []);
});

test("findOrphanedTestFiles does not flag a broad test file with no single inferable implementation target", () => {
  const coderDiff = diffFor(["server.js"]);
  const fullDiff = diffFor(["server.js", "tests/integration.test.js"]);
  assert.deepEqual(findOrphanedTestFiles(fullDiff, coderDiff), []);
});

test("findOrphanedTestFiles flags test_utils.py when the Coder never touched utils.py (Python convention)", () => {
  const coderDiff = diffFor(["app.py"]);
  const fullDiff = diffFor(["app.py", "test_utils.py", "utils.py"]);
  assert.deepEqual(findOrphanedTestFiles(fullDiff, coderDiff), ["test_utils.py"]);
});

test("findOrphanedTestFiles does not flag a nested-path test matching a nested-path file the Coder touched", () => {
  const coderDiff = diffFor(["src/components/Foo.tsx"]);
  const fullDiff = diffFor(["src/components/Foo.tsx", "src/components/Foo.test.tsx"]);
  assert.deepEqual(findOrphanedTestFiles(fullDiff, coderDiff), []);
});

test("findOrphanedTestFiles flags a nested-path test whose nested-path implementation file the Coder never touched", () => {
  const coderDiff = diffFor(["src/components/Bar.tsx"]);
  const fullDiff = diffFor(["src/components/Bar.tsx", "src/components/Foo.test.tsx", "src/components/Foo.tsx"]);
  assert.deepEqual(findOrphanedTestFiles(fullDiff, coderDiff), ["src/components/Foo.test.tsx"]);
});

test("findMockLanguageMarkers does not scan a Python test file's own content (DIFF_TEST_FILE_PATTERN covers pytest convention)", () => {
  const diff =
    diffFor(["app.py"]) +
    "\n+++ b/test_app.py\n@@ -0,0 +1,2 @@\n+# this comment mentions simulate but is in a test file\n+assert True";
  assert.deepEqual(findMockLanguageMarkers(diff), []);
});

test("findMockLanguageMarkers still flags placeholder language in a non-test file", () => {
  const diff =
    "+++ b/pages/index.js\n@@ -0,0 +1,2 @@\n+// Simulate starting the recording process (this would be replaced with actual audio recording logic)\n+const x = 1;";
  const hits = findMockLanguageMarkers(diff);
  assert.ok(hits.length > 0, "expected at least one mock-language marker to be found");
});

test("isApproved is true for a full approval with passing tests", () => {
  assert.equal(isApproved("approve", 0), true);
});

test("isApproved is true for a partial approval with passing tests - both open a PR", () => {
  assert.equal(isApproved("approve_partial", 0), true);
});

test("isApproved is false for a partial approval whose tests didn't actually pass", () => {
  assert.equal(isApproved("approve_partial", 1), false);
});

test("isApproved is false for retry/give_up regardless of test exit code", () => {
  assert.equal(isApproved("retry", 0), false);
  assert.equal(isApproved("give_up", 0), false);
});

// advanceAttemptLoop: the real fix for task #53's attempts 1-2, both pure
// infra failures (Coder exhausted iterations, Tester produced no output)
// that burned real attempt budget identically to a genuine Reviewer
// rejection, leaving only attempt 3 to ever do real work.

test("advanceAttemptLoop retries the SAME attempt on an infra failure, within the infra-retry budget", () => {
  const state: AttemptLoopState = { attempt: 1, infraRetries: 0 };
  const { next, shouldBreak } = advanceAttemptLoop(state, { kind: "infra_failure" }, LOOP_CONFIG);
  assert.deepEqual(next, { attempt: 1, infraRetries: 1 });
  assert.equal(shouldBreak, false);
});

test("advanceAttemptLoop reproduces task #53 exactly: 2 consecutive infra failures (within budget) then a real attempt, using only attempt 1's slot", () => {
  let state: AttemptLoopState = { attempt: 1, infraRetries: 0 };

  // Attempt 1's Coder round: exhausted iterations, no output.
  ({ next: state } = advanceAttemptLoop(state, { kind: "infra_failure" }, LOOP_CONFIG));
  assert.deepEqual(state, { attempt: 1, infraRetries: 1 });

  // Still attempt 1: Tester round produced no output.
  ({ next: state } = advanceAttemptLoop(state, { kind: "infra_failure" }, LOOP_CONFIG));
  assert.deepEqual(state, { attempt: 1, infraRetries: 2 });

  // Still attempt 1: this time it runs end-to-end and gets approved.
  const { next, shouldBreak } = advanceAttemptLoop(state, { kind: "approved" }, LOOP_CONFIG);
  assert.deepEqual(next, { attempt: 1, infraRetries: 0 });
  assert.equal(shouldBreak, true);
});

test("advanceAttemptLoop falls back to charging a real attempt once the infra-retry budget is exhausted", () => {
  // maxInfraRetries: 2 - a third consecutive infra failure must finally cost a real attempt.
  const state: AttemptLoopState = { attempt: 1, infraRetries: 2 };
  const { next, shouldBreak } = advanceAttemptLoop(state, { kind: "infra_failure" }, LOOP_CONFIG);
  assert.deepEqual(next, { attempt: 2, infraRetries: 0 });
  assert.equal(shouldBreak, false);
});

test("advanceAttemptLoop stops (doesn't advance past maxAttempts) when infra budget is exhausted on the last attempt", () => {
  const state: AttemptLoopState = { attempt: 3, infraRetries: 2 };
  const { next, shouldBreak } = advanceAttemptLoop(state, { kind: "infra_failure" }, LOOP_CONFIG);
  assert.deepEqual(next, { attempt: 3, infraRetries: 0 });
  assert.equal(shouldBreak, true);
});

test("advanceAttemptLoop resets the infra-retry budget once a later attempt gets its own fresh start", () => {
  // Attempt 2 shouldn't inherit attempt 1's spent infra budget.
  const state: AttemptLoopState = { attempt: 2, infraRetries: 0 };
  const { next } = advanceAttemptLoop(state, { kind: "infra_failure" }, LOOP_CONFIG);
  assert.deepEqual(next, { attempt: 2, infraRetries: 1 });
});

test("advanceAttemptLoop stops immediately on approve, regardless of infra-retry count", () => {
  const state: AttemptLoopState = { attempt: 2, infraRetries: 1 };
  const { next, shouldBreak } = advanceAttemptLoop(state, { kind: "approved" }, LOOP_CONFIG);
  assert.deepEqual(next, { attempt: 2, infraRetries: 0 });
  assert.equal(shouldBreak, true);
});

test("advanceAttemptLoop advances to the next attempt on a genuine Reviewer retry verdict", () => {
  const state: AttemptLoopState = { attempt: 1, infraRetries: 0 };
  const { next, shouldBreak } = advanceAttemptLoop(state, { kind: "reviewer_retry" }, LOOP_CONFIG);
  assert.deepEqual(next, { attempt: 2, infraRetries: 0 });
  assert.equal(shouldBreak, false);
});

test("advanceAttemptLoop stops on a Reviewer retry verdict at the last attempt instead of advancing past maxAttempts", () => {
  const state: AttemptLoopState = { attempt: 3, infraRetries: 0 };
  const { next, shouldBreak } = advanceAttemptLoop(state, { kind: "reviewer_retry" }, LOOP_CONFIG);
  assert.deepEqual(next, { attempt: 3, infraRetries: 0 });
  assert.equal(shouldBreak, true);
});

test("advanceAttemptLoop stops immediately on a give_up/approve_partial-rejected verdict ('other_terminal')", () => {
  const state: AttemptLoopState = { attempt: 1, infraRetries: 0 };
  const { next, shouldBreak } = advanceAttemptLoop(state, { kind: "other_terminal" }, LOOP_CONFIG);
  assert.deepEqual(next, { attempt: 1, infraRetries: 0 });
  assert.equal(shouldBreak, true);
});
