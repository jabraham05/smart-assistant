import express from "express";
import { loadConfig } from "./config.js";
import { checkSchema, getResearchSessionDetail, getLatestResearchSessionByOriginSession } from "./db.js";
import { ingestDocument } from "./engine/ingest.js";
import { search } from "./engine/search.js";
import { research } from "./engine/research.js";

const config = loadConfig(process.env);

const app = express();
// Generous limit: a base64-encoded PDF manual sent via /documents/ingest
// runs well past express's 100kb default (a real multi-hundred-page manual,
// base64-inflated ~33%, can land in the tens of MB).
app.use(express.json({ limit: "150mb" }));

// Phase 0 checkpoint: proves the service connects to the real `research`
// database and the tables from 08-create-knowledge-tables.sql exist, not
// just that the process started.
app.get("/health", async (_req, res) => {
  try {
    const schema = await checkSchema(config);
    res.json(schema);
  } catch (e) {
    console.error("health check failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /documents/ingest - direct knowledge ingestion (remember()).
// text/url/pdf. Local-file PDF ingestion is CLI-only via
// scripts/ingest-document.mjs, since no upload channel exists in chat-ui.
app.post("/documents/ingest", async (req, res) => {
  const body = req.body as {
    sourceType?: "text" | "url" | "pdf";
    text?: string;
    url?: string;
    pdfBase64?: string;
    title?: string;
    domain?: string;
    metadata?: Record<string, unknown>;
    triggerSource?: string;
    originSessionId?: string;
  };

  if (body.sourceType !== "text" && body.sourceType !== "url" && body.sourceType !== "pdf") {
    return res.status(400).json({ error: "sourceType must be 'text', 'url', or 'pdf'" });
  }

  try {
    const result = await ingestDocument(config, {
      sourceType: body.sourceType,
      text: body.text,
      url: body.url,
      pdfBase64: body.pdfBase64,
      title: body.title,
      domain: body.domain,
      metadata: body.metadata,
      triggerSource: body.triggerSource,
      originSessionId: body.originSessionId,
    });
    res.status(201).json(result);
  } catch (e) {
    console.error("failed to ingest document:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /search - hybrid retrieval (vector + keyword via Reciprocal Rank
// Fusion) with first-class citations per result.
app.post("/search", async (req, res) => {
  const body = req.body as {
    query?: string;
    domain?: string;
    metadataFilter?: Record<string, unknown>;
    includeStale?: boolean;
    topK?: number;
  };

  if (!body.query || typeof body.query !== "string") {
    return res.status(400).json({ error: "query is required" });
  }

  try {
    const results = await search(config, {
      query: body.query,
      domain: body.domain,
      metadataFilter: body.metadataFilter,
      includeStale: body.includeStale,
      topK: body.topK,
    });
    res.json({ results });
  } catch (e) {
    console.error("failed to search:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /research - deterministic knowledge-vs-web routing; a web
// escalation runs the full research agent and persists the result
// (research_sessions/findings/citations, plus a searchable document).
// Synchronous for now - becomes fire-and-forget if a real research run's
// latency (multiple web fetches + an agent loop) ever proves too slow for
// a caller to wait on directly.
app.post("/research", async (req, res) => {
  const body = req.body as { query?: string; domain?: string; triggerSource?: string; originSessionId?: string };

  if (!body.query || typeof body.query !== "string") {
    return res.status(400).json({ error: "query is required" });
  }

  try {
    const result = await research(config, {
      query: body.query,
      domain: body.domain,
      triggerSource: body.triggerSource,
      originSessionId: body.originSessionId,
    });
    res.json(result);
  } catch (e) {
    console.error("failed to research:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /research/status?sessionId=<chat session id> - same pattern as the
// old research_task_status: latest research run started from this chat
// session, for a mid-conversation progress check.
//
// Registered BEFORE /research/:id deliberately - Express matches routes in
// registration order, and a parameterized /research/:id would otherwise
// greedily match "status" as the :id value, intercepting every request
// here before it ever reached this handler. Caught live: this route
// returned {"error":"invalid research session id"} (the OTHER handler's
// error) instead of ever running its own body, until the order was fixed.
app.get("/research/status", async (req, res) => {
  const originSessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  if (!originSessionId) {
    return res.status(400).json({ error: "sessionId query param is required" });
  }

  try {
    const session = await getLatestResearchSessionByOriginSession(config, originSessionId);
    if (!session) return res.json({ found: false });
    res.json({ found: true, status: session.status, topic: session.topic, sessionId: session.id, documentId: session.document_id });
  } catch (e) {
    console.error("failed to get research status:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /research/:id - full session detail: every finding plus its
// citations (including contested ones), not just a flat markdown summary.
app.get("/research/:id", async (req, res) => {
  const sessionId = Number(req.params.id);
  if (!Number.isInteger(sessionId)) {
    return res.status(400).json({ error: "invalid research session id" });
  }

  try {
    const detail = await getResearchSessionDetail(config, sessionId);
    if (!detail) return res.status(404).json({ error: `research session ${sessionId} not found` });
    res.json(detail);
  } catch (e) {
    console.error(`failed to get research session ${sessionId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`knowledge-engine listening on :${config.port}`);
});
