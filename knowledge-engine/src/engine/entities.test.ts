import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Config } from "../config.js";
import type { EntityRow } from "../db.js";
import { toFrontmatter, relativePath, readEntityFile } from "./entities.js";

function fakeEntity(overrides: Partial<EntityRow> = {}): EntityRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    type: "project",
    name: "Test Project",
    description: "Some body text.",
    status: "done",
    source_table: null,
    source_id: null,
    source_path: null,
    graphiti_id: null,
    metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

test("relativePath buckets by type and names the file after the entity id", () => {
  const entity = fakeEntity();
  assert.equal(relativePath(entity), path.join("project", `${entity.id}.md`));
});

test("toFrontmatter includes the structured fields a human needs without a SQL client", () => {
  const entity = fakeEntity();
  const frontmatter = toFrontmatter(entity);
  assert.match(frontmatter, /^---\n/);
  assert.match(frontmatter, /id: 11111111-1111-1111-1111-111111111111/);
  assert.match(frontmatter, /type: project/);
  assert.match(frontmatter, /name: Test Project/);
  assert.match(frontmatter, /status: done/);
});

// Proves the actual read-back path (readEntityFile) against a real file on
// disk, same spirit as grounding.test.ts exercising the real check rather
// than a mock - the thing this phase exists to prove is that a written
// entity file can genuinely be read back, not just that the write call
// didn't throw.
test("readEntityFile round-trips a file written at the entity's source_path", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "knowledge-store-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const entity = fakeEntity({ source_path: relativePath(fakeEntity()) });
  const absPath = path.join(dir, entity.source_path!);
  await mkdir(path.dirname(absPath), { recursive: true });
  const content = toFrontmatter(entity) + entity.description;
  await writeFile(absPath, content, "utf8");

  const config = { knowledgeStorePath: dir } as Config;
  const result = await readEntityFile(config, entity);
  assert.equal(result, content);
});

test("readEntityFile returns undefined when the entity has no source_path", async () => {
  const config = { knowledgeStorePath: "/does/not/matter" } as Config;
  const result = await readEntityFile(config, fakeEntity({ source_path: null }));
  assert.equal(result, undefined);
});

test("readEntityFile returns undefined when the file is missing on disk", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "knowledge-store-test-"));
  const config = { knowledgeStorePath: dir } as Config;
  const entity = fakeEntity({ source_path: relativePath(fakeEntity()) });
  const result = await readEntityFile(config, entity);
  assert.equal(result, undefined);
  await rm(dir, { recursive: true, force: true });
});
