#!/usr/bin/env node
// Full clean-slate reset: wipes Honcho (hosted long-term memory), the
// postgres-data and falkordb-data docker volumes, Redis, and
// ./knowledge-store, then brings the stack back up and restores the few
// things that have no other backup.
//
// Why this exists: test traffic was leaking into the real Honcho profile
// (see agent-service/src/config.py's is_test_user) and there was no
// existing tool anywhere in this repo to wipe memory/chat-history state
// and start over cleanly - this is that tool, written once so it can be
// reused instead of another by-hand purge.
//
// n8n-data and ollama-data are DELIBERATELY left untouched - only
// postgres-data and falkordb-data are in scope for this reset.
//
// Usage: node scripts/reset-everything.mjs --confirm
// Requires HONCHO_API_KEY, HONCHO_WORKSPACE_ID (defaults to
// "smart-assistant"), and POSTGRES_PASSWORD in the environment (same as
// every other script here - source your .env into the shell first).
//
// CRITICAL, UNVERIFIED ASSUMPTIONS (see docs on this script's PR) - this
// has not yet been run against a live stack:
//  - Honcho's /sessions/list pagination response shape (assumed
//    `{ items: [...], pages: N }`) - adjust _listAllSessionIds below if
//    Honcho's real response differs.
//  - n8n recreates the two Data Table physical tables with the same
//    columns on a fresh database before this script's restore step runs -
//    if it doesn't (e.g. n8n's Data Tables feature needs to be opened in
//    the UI once first), Step 4's restore will fail loudly with a clear
//    error rather than silently losing the snapshot (the JSON files in
//    ./backups/ are kept either way).
// Run this against a non-production environment first if at all possible.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

if (!process.argv.includes("--confirm")) {
  console.error(
    "This permanently deletes Honcho's workspace, the postgres-data/falkordb-data volumes, " +
      "Redis, and ./knowledge-store contents. Re-run with --confirm to proceed.",
  );
  process.exit(1);
}

const honchoApiKey = process.env.HONCHO_API_KEY;
if (!honchoApiKey) {
  console.error("Set HONCHO_API_KEY in the environment");
  process.exit(1);
}
const workspaceId = process.env.HONCHO_WORKSPACE_ID || "smart-assistant";
const honchoBase = `https://api.honcho.dev/v3/workspaces/${workspaceId}`;
const honchoHeaders = {
  Authorization: `Bearer ${honchoApiKey}`,
  "Content-Type": "application/json",
};

const postgresPassword = process.env.POSTGRES_PASSWORD;
if (!postgresPassword) {
  console.error("Set POSTGRES_PASSWORD in the environment");
  process.exit(1);
}

const PERSONAS_TABLE = '"data_table_user_9E02ctNxKP8AGEqI"';
const SKILLS_TABLE = '"data_table_user_suWDTLC9t3H1ESud"';

function log(step, msg) {
  console.log(`[reset-everything] ${step}: ${msg}`);
}

// docker compose exec needs the container's own env for POSTGRES_PASSWORD -
// it already has it (docker-compose.yml), so nothing extra to pass through.
function psql(database, sql) {
  const result = spawnSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "assistant", "-d", database, "-t", "-A"],
    { cwd: repoRoot, input: sql, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`psql against ${database} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function dockerCompose(args, opts = {}) {
  const result = spawnSync("docker", ["compose", ...args], { cwd: repoRoot, stdio: "inherit", ...opts });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed (exit ${result.status})`);
  }
}

// ============================================================
// Step 0: snapshot the n8n Data Table rows (personas/skills) - the only
// copy of this data anywhere once postgres-data is wiped.
// ============================================================
async function snapshotDataTables() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(repoRoot, "backups", `reset-${stamp}`);
  mkdirSync(backupDir, { recursive: true });

  const personasJson = psql("n8n", `SELECT coalesce(json_agg(t), '[]') FROM ${PERSONAS_TABLE} t;`).trim();
  const skillsJson = psql("n8n", `SELECT coalesce(json_agg(t), '[]') FROM ${SKILLS_TABLE} t;`).trim();

  const personas = JSON.parse(personasJson || "[]");
  const skills = JSON.parse(skillsJson || "[]");

  if (personas.length === 0 && skills.length === 0) {
    throw new Error(
      "Snapshot of personas/skills Data Table rows came back empty for BOTH tables - this almost " +
        "certainly means something is wrong (wrong database/table name, postgres unreachable), not that " +
        "they're genuinely empty. Aborting before wiping anything. Check manually and re-run.",
    );
  }

  writeFileSync(join(backupDir, "personas.json"), JSON.stringify(personas, null, 2));
  writeFileSync(join(backupDir, "skills.json"), JSON.stringify(skills, null, 2));
  log("step0", `snapshotted ${personas.length} persona row(s), ${skills.length} skill row(s) -> ${backupDir}`);
  return { personas, skills, personasJson, skillsJson };
}

// ============================================================
// Step 1: wipe Honcho - delete every session, then the whole workspace.
// ============================================================
async function listAllSessionIds() {
  const ids = [];
  let page = 1;
  const size = 100;
  for (;;) {
    const res = await fetch(`${honchoBase}/sessions/list`, {
      method: "POST",
      headers: honchoHeaders,
      body: JSON.stringify({ page, size }),
    });
    if (!res.ok) {
      throw new Error(`Honcho sessions/list failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const body = await res.json();
    const items = body.items ?? body.data ?? [];
    for (const item of items) {
      if (item?.id) ids.push(item.id);
    }
    if (items.length < size) break;
    page += 1;
    if (page > 1000) {
      throw new Error("Honcho sessions/list pagination exceeded 1000 pages - aborting, check manually");
    }
  }
  return ids;
}

async function wipeHoncho() {
  const sessionIds = await listAllSessionIds();
  log("step1", `found ${sessionIds.length} Honcho session(s) to delete`);
  for (const id of sessionIds) {
    const res = await fetch(`${honchoBase}/sessions/${id}`, { method: "DELETE", headers: honchoHeaders });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Failed to delete Honcho session ${id}: ${res.status}`);
    }
  }

  // Session deletion is async on Honcho's side - the workspace delete
  // requires zero active sessions, so retry through the race instead of
  // failing on the first attempt.
  for (let attempt = 1; attempt <= 10; attempt++) {
    const res = await fetch(honchoBase, { method: "DELETE", headers: honchoHeaders });
    if (res.ok) {
      log("step1", "Honcho workspace deleted");
      return;
    }
    if (res.status === 409 && attempt < 10) {
      log("step1", `workspace delete got 409 (sessions still finishing deletion), retrying (${attempt}/10)`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    throw new Error(`Failed to delete Honcho workspace: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

async function honchoCanary() {
  // Honcho's workspace/session creation is get-or-create everywhere else
  // in this codebase - confirm that holds after a full workspace delete
  // too, rather than silently leaving things broken until the first real
  // chat turn discovers it.
  const res = await fetch(`${honchoBase}/sessions`, {
    method: "POST",
    headers: honchoHeaders,
    body: JSON.stringify({ id: "reset-everything-canary" }),
  });
  if (!res.ok) {
    throw new Error(
      `Honcho canary session-create failed after workspace delete (${res.status}) - workspace may not ` +
        "have been lazily recreated the way the rest of this codebase assumes. Investigate before relying " +
        "on Honcho again.",
    );
  }
  await fetch(`${honchoBase}/sessions/reset-everything-canary`, { method: "DELETE", headers: honchoHeaders }).catch(
    () => {},
  );
  log("step1", "Honcho canary session create/delete succeeded - workspace is usable again");
}

// ============================================================
// Step 2: stop the stack, wipe scoped volumes/mounts.
// ============================================================
function wipeVolumesAndKnowledgeStore() {
  dockerCompose(["down"]);
  // Exactly these two - never -v on the compose down above, which would
  // also take n8n-data/ollama-data (explicitly out of scope).
  for (const vol of ["assistant_postgres-data", "assistant_falkordb-data"]) {
    const result = spawnSync("docker", ["volume", "rm", vol], { stdio: "inherit" });
    if (result.status !== 0) {
      console.warn(`[reset-everything] step2: couldn't remove volume ${vol} (may not exist) - continuing`);
    }
  }
  const knowledgeStore = join(repoRoot, "knowledge-store");
  if (existsSync(knowledgeStore)) {
    for (const entry of readdirSync(knowledgeStore)) {
      rmSync(join(knowledgeStore, entry), { recursive: true, force: true });
    }
  }
  log("step2", "stack stopped, postgres-data/falkordb-data removed, knowledge-store cleared");
}

// ============================================================
// Step 3: bring the stack back up.
// ============================================================
function bringStackUp() {
  dockerCompose(["up", "-d"]);
  // Fresh postgres-data needs a moment for postgres to finish replaying
  // postgres/init/*.sql before anything else can query it.
  const ready = spawnSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "pg_isready", "-U", "assistant"],
    { cwd: repoRoot },
  );
  if (ready.status !== 0) {
    log("step3", "postgres not immediately ready - waiting 10s and re-checking once");
    spawnSync("sleep", ["10"]);
  }
  const flush = spawnSync("docker", ["compose", "exec", "-T", "redis", "redis-cli", "FLUSHALL"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (flush.status !== 0) {
    console.warn("[reset-everything] step3: redis FLUSHALL failed (non-fatal, redis has no volume anyway)");
  }
  log("step3", "stack is back up");
}

// ============================================================
// Step 4: re-seed what doesn't come back automatically.
// ============================================================
function restoreDataTables(personasJson, skillsJson) {
  for (const [table, json] of [
    [PERSONAS_TABLE, personasJson],
    [SKILLS_TABLE, skillsJson],
  ]) {
    const sql = `INSERT INTO ${table} SELECT * FROM json_populate_recordset(null::${table}, $json$${json}$json$::json);`;
    try {
      psql("n8n", sql);
    } catch (e) {
      throw new Error(
        `Restoring ${table} failed - likely means n8n hasn't recreated this Data Table yet (open its Data ` +
          `Tables feature in the n8n UI once, then re-run just this restore step manually). Underlying error: ${e.message}`,
      );
    }
  }
  log("step4", "restored personas/skills Data Table rows");
}

function importWorkflows() {
  const result = spawnSync("bash", [join(__dirname, "import-n8n-workflows.sh")], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("import-n8n-workflows.sh failed - workflows were NOT restored, see output above");
  }
  log("step4", "re-imported n8n workflows");
}

function setPeerCards() {
  const userId = process.env.AMY_USER_ID;
  if (!userId || userId === "test") {
    console.warn(
      "[reset-everything] step4: AMY_USER_ID not set to a real identity - skipping peer-card bootstrap. " +
        "Run `node scripts/set-peer-cards.mjs --user=<your real id>` manually once you've decided on one.",
    );
    return;
  }
  execFileSync("node", [join(__dirname, "set-peer-cards.mjs"), `--user=${userId}`], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  log("step4", `re-bootstrapped peer cards for user_id=${userId}`);
}

async function main() {
  const { personasJson, skillsJson } = await snapshotDataTables();
  await wipeHoncho();
  wipeVolumesAndKnowledgeStore();
  bringStackUp();
  await honchoCanary();
  restoreDataTables(personasJson, skillsJson);
  importWorkflows();
  setPeerCards();
  console.log(
    "\n[reset-everything] Done. Verify: docker compose ps, then `node scripts/chat.mjs \"hi\" --user=<your id>`.",
  );
}

main().catch((e) => {
  console.error(`[reset-everything] FAILED: ${e.message}`);
  process.exit(1);
});
