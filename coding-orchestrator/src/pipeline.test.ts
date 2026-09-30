// coding-orchestrator had zero test coverage before this - the deterministic
// review-override helpers in pipeline.ts (findMockLanguageMarkers,
// findOrphanedTestFiles) exist specifically to catch confabulation the LLM
// Reviewer missed, so they need real coverage more than most code here,
// not less. Same node:test convention skills-mcp already uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findMockLanguageMarkers, findOrphanedTestFiles } from "./pipeline.js";

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
