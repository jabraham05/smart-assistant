import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import * as db from "../db.js";

// Phase 1 of the "Amy's world" rework: pairs each entities row with a
// durable, human-readable markdown file under KNOWLEDGE_STORE_PATH - the
// piece neither knowledge-engine's Postgres-only documents table nor
// memory-engine's embedding-only memory_entries table has ever had. The
// Postgres row stays the structured source of truth (status, timestamps,
// provenance); the file is for a human (or a future file-reading phase) to
// actually read without a SQL client. No frontmatter parser/library - a
// handful of plain `key: value` lines is enough for phase 1, and avoids
// adding a YAML dependency this service has never needed before.
export function toFrontmatter(entity: db.EntityRow): string {
  const lines = [
    "---",
    `id: ${entity.id}`,
    `type: ${entity.type}`,
    `name: ${entity.name}`,
    `status: ${entity.status ?? ""}`,
    `created_at: ${entity.created_at}`,
    "---",
    "",
  ];
  return lines.join("\n");
}

export function relativePath(entity: db.EntityRow): string {
  // Flat, type-bucketed layout for phase 1 - deliberately not the full
  // user/amy/projects/knowledge/... tree from the architecture sketch,
  // since nothing populates those directories yet (see docs on this
  // phase). Easy to grow into once later phases define real producers.
  return path.join(entity.type, `${entity.id}.md`);
}

export interface CreateEntityInput {
  type: string;
  name: string;
  description?: string;
  status?: string;
  sourceTable?: string;
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

// Creates the Postgres row first (the structured source of truth), then
// writes the backing file and immediately records its path on the row -
// if the file write fails, the entity still exists and can be retried/
// inspected rather than silently having no durable artifact at all.
export async function createEntity(config: Config, input: CreateEntityInput): Promise<db.EntityRow> {
  let entity = await db.insertEntity(config, input);

  const relPath = relativePath(entity);
  const absPath = path.join(config.knowledgeStorePath, relPath);
  await mkdir(path.dirname(absPath), { recursive: true });
  await writeFile(absPath, toFrontmatter(entity) + (entity.description ?? ""), "utf8");

  const updated = await db.updateEntity(config, entity.id, { sourcePath: relPath });
  return updated ?? entity;
}

export async function readEntityFile(config: Config, entity: db.EntityRow): Promise<string | undefined> {
  if (!entity.source_path) return undefined;
  const absPath = path.join(config.knowledgeStorePath, entity.source_path);
  try {
    return await readFile(absPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export interface KnowledgeStoreFile {
  relativePath: string;
  size: number;
  mtime: string;
}

// Raw directory browser over KNOWLEDGE_STORE_PATH, independent of the
// `entities` registry - catches every file on disk, including ones from
// future producers that write straight to the store without an entities
// row. Paths use forward slashes regardless of OS, since this is exposed
// over HTTP for a browser-side file tree, not used for local fs calls.
async function walkKnowledgeStoreDir(root: string, dir: string): Promise<KnowledgeStoreFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: KnowledgeStoreFile[] = [];
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkKnowledgeStoreDir(root, absPath)));
    } else if (entry.isFile()) {
      const stats = await stat(absPath);
      files.push({
        relativePath: path.relative(root, absPath).split(path.sep).join("/"),
        size: stats.size,
        mtime: stats.mtime.toISOString(),
      });
    }
  }
  return files;
}

export async function listKnowledgeStoreFiles(config: Config): Promise<KnowledgeStoreFile[]> {
  try {
    return await walkKnowledgeStoreDir(config.knowledgeStorePath, config.knowledgeStorePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

// Client-supplied path, unlike readEntityFile's server-generated
// entity.source_path - must validate the resolved path never escapes
// knowledgeStorePath before reading (path traversal via "../../etc/passwd"
// or an absolute path override).
export async function readKnowledgeStoreFile(config: Config, relativePath: string): Promise<string | undefined> {
  const root = path.resolve(config.knowledgeStorePath);
  const absPath = path.resolve(root, relativePath);
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    throw new Error("path escapes the knowledge store root");
  }
  try {
    return await readFile(absPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

// Best-effort link-back from an entity to the Graphiti episode its creation
// fired (see consolidate.ts) - called from a fire-and-forget .then(), so a
// failure here must never throw past the caller; it just leaves graphiti_id
// unset for this entity, same "never block/break the real write" stance
// graphiti-service's own episode writes already follow everywhere else.
export async function backfillGraphitiId(config: Config, entityId: string, graphitiId: string): Promise<void> {
  try {
    await db.updateEntity(config, entityId, { graphitiId });
  } catch (e) {
    console.error(`failed to backfill graphiti_id for entity ${entityId}:`, e);
  }
}
