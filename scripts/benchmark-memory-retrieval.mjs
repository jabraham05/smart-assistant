#!/usr/bin/env node
// Benchmarks memory-engine's self-hosted hybrid search against Honcho's
// hosted dialectic /chat endpoint on real, already-stored conversation
// history (every turn is ingested into memory-engine unconditionally, and
// Honcho retains all stored messages too, so both systems are being asked
// about the exact same underlying facts).
//
// Usage:
//   node scripts/benchmark-memory-retrieval.mjs
//   node scripts/benchmark-memory-retrieval.mjs --reasoning=minimal,low
//   MEMORY_ENGINE_URL=http://memory-engine:3007 HONCHO_API_KEY=... HONCHO_WORKSPACE_ID=... \
//     node scripts/benchmark-memory-retrieval.mjs
//
// Writes a full JSON + Markdown report under scripts/benchmark-results/.
// Honcho's dialectic endpoint makes real per-query LLM calls server-side -
// reasoning_level controls how many (minimal=1 tool iteration, low=up to 5).

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const rawArgs = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const MEMORY_ENGINE_URL = process.env.MEMORY_ENGINE_URL || "http://memory-engine:3007";
const HONCHO_BASE_URL = "https://api.honcho.dev/v3";
const HONCHO_API_KEY = process.env.HONCHO_API_KEY;
const HONCHO_WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID || "smart-assistant";
const reasoningLevels = (rawArgs.reasoning || "minimal,low").split(",");

if (!HONCHO_API_KEY) {
  console.error("HONCHO_API_KEY is required (env var).");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Test queries — each targets a real, already-verified fact pulled directly
// from this workspace's actual stored conversation history (not synthetic
// fixtures). See the benchmark plan for how each was confirmed.
// ---------------------------------------------------------------------------
const QUERIES = [
  // "historical" - predates memory-engine's own ingestion start (it only
  // began recording turns once deployed, ~2026-09-21T21:02Z at benchmark
  // time - confirmed via `SELECT min(created_at) FROM memory_entries`).
  // Honcho has retained messages since project start, so these are NOT a
  // fair apples-to-apples test of retrieval quality - they mostly measure
  // memory-engine's data-coverage gap. Kept and labeled rather than
  // dropped, since that gap is itself a real finding for the decision.
  {
    name: "brake-fluid",
    query: "What brake fluid does my Porsche Cayman need?",
    check: (t) => /dot.{0,2}4/i.test(t),
    coverage: "historical",
  },
  {
    name: "fuel-tank-empty",
    query: "What was the empty fuel tank sender reading I measured?",
    check: (t) => /240/.test(t),
    coverage: "historical",
  },
  {
    name: "fuel-tank-full",
    query: "What was the full fuel tank sender reading I measured?",
    check: (t) => /480/.test(t),
    coverage: "historical",
  },
  {
    name: "bitcoin-block-time",
    query: "According to the Bitcoin whitepaper, how often are blocks mined?",
    check: (t) => /10.{0,12}minut/i.test(t),
    coverage: "historical",
  },
  {
    name: "gtr-research",
    query: "What have I researched about the upcoming Nissan GT-R successor?",
    check: (t) => /gt-?r|nissan/i.test(t),
    coverage: "historical",
  },
  // "recent" - within memory-engine's actual coverage window, verified
  // directly against memory_entries before writing these. Fair test of
  // retrieval quality for both systems on the same underlying data.
  {
    name: "nordstrom-job",
    query: "What company did I apply to and make it to the final round with?",
    check: (t) => /nordstrom/i.test(t),
    coverage: "recent",
  },
  {
    name: "robotic-arm-project",
    query: "What new project am I researching involving a robotic arm?",
    check: (t) => /robot.{0,3}arm|arm.{0,3}robot/i.test(t),
    coverage: "recent",
  },
  {
    name: "workout-split",
    query: "What workout split have I been doing?",
    check: (t) => /arnold/i.test(t),
    coverage: "recent",
  },
  {
    name: "porsche-manual",
    query: "What car do I have that I asked for the owner's manual for?",
    check: (t) => /porsche|cayman|987/i.test(t),
    coverage: "recent",
  },
  {
    name: "removed-goals",
    query: "Which goals did I ask to remove recently?",
    check: (t) => /guitar|cooking/i.test(t),
    coverage: "recent",
  },
];

// ---------------------------------------------------------------------------
// System clients
// ---------------------------------------------------------------------------
async function queryMemoryEngine(query) {
  const start = performance.now();
  const res = await fetch(`${MEMORY_ENGINE_URL}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, topK: 5 }),
  });
  const totalMs = performance.now() - start;
  if (!res.ok) throw new Error(`memory-engine /search failed: ${res.status}`);
  const data = await res.json();
  // Concatenate all returned snippets - a query is a "hit" if the expected
  // fact shows up anywhere in the top-5, same recall@topK framing
  // memory_recall itself effectively uses.
  const text = (data.results || []).map((r) => r.content).join("\n---\n");
  return { text, totalMs, raw: data.results };
}

async function queryHonchoDialectic(query, reasoningLevel) {
  const start = performance.now();
  const res = await fetch(
    `${HONCHO_BASE_URL}/workspaces/${HONCHO_WORKSPACE_ID}/peers/user/chat`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HONCHO_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, reasoning_level: reasoningLevel }),
    }
  );
  const totalMs = performance.now() - start;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Honcho /chat failed: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return { text: data.content || "", totalMs, raw: data };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
const targets = ["memory-engine", ...reasoningLevels.map((r) => `honcho-${r}`)];
const results = Object.fromEntries(targets.map((t) => [t, { cases: [], errors: [] }]));

console.error(`Targets: ${targets.join(", ")}\n`);

for (const q of QUERIES) {
  console.error(`--- ${q.name}: "${q.query}" ---`);

  // memory-engine
  try {
    const r = await queryMemoryEngine(q.query);
    const pass = q.check(r.text);
    console.error(`  [memory-engine] ${pass ? "PASS" : "FAIL"} (${r.totalMs.toFixed(0)}ms)`);
    results["memory-engine"].cases.push({
      name: q.name,
      coverage: q.coverage,
      pass,
      totalMs: r.totalMs,
      response: r.text.slice(0, 500),
      raw: r.raw,
    });
  } catch (err) {
    console.error(`  [memory-engine] ERROR — ${err.message}`);
    results["memory-engine"].cases.push({ name: q.name, coverage: q.coverage, pass: false, error: err.message });
    results["memory-engine"].errors.push(`${q.name}: ${err.message}`);
  }

  // Honcho, per reasoning level
  for (const level of reasoningLevels) {
    const target = `honcho-${level}`;
    try {
      const r = await queryHonchoDialectic(q.query, level);
      const pass = q.check(r.text);
      console.error(`  [${target}] ${pass ? "PASS" : "FAIL"} (${r.totalMs.toFixed(0)}ms) — "${r.text.slice(0, 80)}"`);
      results[target].cases.push({
        name: q.name,
        coverage: q.coverage,
        pass,
        totalMs: r.totalMs,
        response: r.text.slice(0, 500),
      });
    } catch (err) {
      console.error(`  [${target}] ERROR — ${err.message}`);
      results[target].cases.push({ name: q.name, coverage: q.coverage, pass: false, error: err.message });
      results[target].errors.push(`${q.name}: ${err.message}`);
    }
  }
}

function avg(arr) {
  const vals = arr.filter((v) => typeof v === "number" && !Number.isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function passRatePct(cases) {
  if (!cases.length) return null;
  return +((cases.filter((c) => c.pass).length / cases.length) * 100).toFixed(1);
}

function summarize(target, result) {
  const recent = result.cases.filter((c) => c.coverage === "recent");
  const historical = result.cases.filter((c) => c.coverage === "historical");
  return {
    target,
    passRatePct: passRatePct(result.cases),
    recentPassRatePct: passRatePct(recent),
    historicalPassRatePct: passRatePct(historical),
    avgLatencyMs: avg(result.cases.map((c) => c.totalMs))?.toFixed(0) ?? null,
    errors: result.errors.length,
  };
}

const summaries = targets.map((t) => summarize(t, results[t]));

function printTable(summaries) {
  const cols = ["target", "recentPassRatePct", "historicalPassRatePct", "passRatePct", "avgLatencyMs", "errors"];
  const headers = ["Target", "Recent %", "Historical %", "Overall %", "Avg latency ms", "Errors"];
  const widths = cols.map((c, i) => Math.max(headers[i].length, ...summaries.map((s) => String(s[c] ?? "-").length)) + 2);
  const line = (vals) => vals.map((v, i) => String(v ?? "-").padEnd(widths[i])).join("");
  console.log("\n" + line(headers));
  console.log(widths.map((w) => "-".repeat(w - 1)).join(" "));
  for (const s of summaries) console.log(line(cols.map((c) => s[c])));
}

printTable(summaries);
console.log(
  '\n"Recent" = within memory-engine\'s actual data-coverage window (fair, apples-to-apples). ' +
    '"Historical" = predates memory-engine\'s ingestion start, Honcho-only coverage (illustrates the coverage gap, not retrieval quality).'
);

const resultsDir = join(__dirname, "benchmark-results");
mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = join(resultsDir, `memory-retrieval-${stamp}.json`);
const mdPath = join(resultsDir, `memory-retrieval-${stamp}.md`);

writeFileSync(
  jsonPath,
  JSON.stringify({ config: { targets, queries: QUERIES.map((q) => q.name) }, results, summaries }, null, 2)
);

const mdRows = summaries
  .map((s) => `| ${s.target} | ${s.recentPassRatePct ?? "-"} | ${s.historicalPassRatePct ?? "-"} | ${s.passRatePct ?? "-"} | ${s.avgLatencyMs ?? "-"} | ${s.errors} |`)
  .join("\n");
const perCaseRows = QUERIES.map((q) => {
  const cells = targets
    .map((t) => {
      const c = results[t].cases.find((c) => c.name === q.name);
      return c ? (c.error ? "ERR" : c.pass ? "✅" : "❌") : "-";
    })
    .join(" | ");
  return `| ${q.name} (${q.coverage}) | ${cells} |`;
}).join("\n");

writeFileSync(
  mdPath,
  `# Memory retrieval benchmark — ${stamp}\n\ntargets=${targets.join(",")}\n\n"Recent" = within memory-engine's actual data-coverage window (fair). "Historical" = predates memory-engine's ingestion start, Honcho-only coverage (illustrates the coverage gap).\n\n## Summary\n\n| Target | Recent % | Historical % | Overall % | Avg latency ms | Errors |\n|---|---|---|---|---|---|\n${mdRows}\n\n## Per-query\n\n| Query | ${targets.join(" | ")} |\n|---|${targets.map(() => "---").join("|")}|\n${perCaseRows}\n`
);

console.log(`\nWrote ${jsonPath}\nWrote ${mdPath}`);
