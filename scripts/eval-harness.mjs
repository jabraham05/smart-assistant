#!/usr/bin/env node
// Fires a fixture set of messages at chat-orchestrator (or, for regression
// comparison, its test instance / the old n8n Chat workflow rollback path)
// and records what actually happened for each one: the real reply,
// latency, and (via the dashboard's read-only DB query API, since
// event-bus itself has no host-published port) the classification event
// chat-orchestrator publishes per turn. This is the baseline every later
// Coordinator phase diffs against - see the plan's Phase 0.
//
// Usage: node scripts/eval-harness.mjs <fixture.json> [chatOrchestratorUrl]
//   chatOrchestratorUrl defaults to http://localhost:3008/webhook (prod).
//   Use http://localhost:3009/webhook for chat-orchestrator-test, or
//   an n8n Chat Trigger Production URL for rollback-path comparison
//   (classification-event lookup will just come back empty in that case -
//   n8n's workflow never had an equivalent instrumented event).

import { readFileSync, writeFileSync } from "node:fs";

const [, , fixturePath, urlArg] = process.argv;
if (!fixturePath) {
  console.error("Usage: node scripts/eval-harness.mjs <fixture.json> [chatOrchestratorUrl]");
  process.exit(1);
}

const webhookUrl = urlArg || "http://localhost:3008/webhook";
const dashboardQueryUrl = process.env.DASHBOARD_URL
  ? `${process.env.DASHBOARD_URL}/api/database/query`
  : "http://localhost:3006/api/database/query";

const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));

function parseNdjsonReply(text) {
  let reply = "";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === "item" && event.content) reply += event.content;
  }
  return reply;
}

async function sendMessage(message, sessionId) {
  const start = Date.now();
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatInput: message, sessionId }),
  });
  const text = await res.text();
  const latencyMs = Date.now() - start;
  if (!res.ok) return { reply: `ERROR ${res.status}: ${text.slice(0, 200)}`, latencyMs };
  return { reply: parseNdjsonReply(text), latencyMs };
}

// origin_session_id is our own generated id (never user input), but quote
// it properly regardless rather than assuming its shape stays simple.
function sqlQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

async function fetchClassification(sessionId) {
  const sql =
    `SELECT payload FROM events WHERE origin_session_id = ${sqlQuote(sessionId)} ` +
    `AND type = 'message_classified' ORDER BY id DESC LIMIT 1`;
  // Fire-and-forget on the server side means the event can land a beat
  // after the HTTP response closes - a few short retries covers that
  // without the harness needing its own artificial fixed delay per case.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(dashboardQueryUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ database: "events", sql }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.rows?.[0]?.payload) return data.rows[0].payload;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

const results = [];
for (const [i, fixture] of fixtures.entries()) {
  const sessionId = `eval-${Date.now()}-${i}`;
  process.stdout.write(`[${i + 1}/${fixtures.length}] "${fixture.message}" ... `);
  try {
    const { reply, latencyMs } = await sendMessage(fixture.message, sessionId);
    const classification = await fetchClassification(sessionId);
    const result = {
      message: fixture.message,
      expectedGroups: fixture.expectedGroups ?? null,
      relevantGroups: classification?.relevantGroups ?? null,
      relevantTools: classification?.relevantTools ?? null,
      classifyMs: classification?.classifyMs ?? null,
      latencyMs,
      reply: reply.slice(0, 200),
    };
    results.push(result);
    console.log(
      `${latencyMs}ms, groups=${result.relevantGroups ? result.relevantGroups.join(",") || "(none)" : "?"}`,
    );
  } catch (e) {
    console.log(`FAILED: ${e.message}`);
    results.push({ message: fixture.message, error: e.message });
  }
}

const outPath = fixturePath.replace(/\.json$/, `.results.${Date.now()}.json`);
writeFileSync(outPath, JSON.stringify(results, null, 2));
console.log(`\nWrote ${results.length} results to ${outPath}`);

const failed = results.filter((r) => r.error || r.relevantGroups === null);
if (failed.length) {
  console.log(`\n${failed.length} message(s) had no classification event or errored - see report.`);
}
