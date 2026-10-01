import express from "express";
import { loadConfig } from "./config.js";
import * as db from "./db.js";
import { embedText } from "./lib/ollama-embeddings.js";

const config = loadConfig(process.env);

const app = express();
app.use(express.json({ limit: "1mb" }));

// Called by chat-orchestrator after every turn (both the user's message
// and Amy's own reply) whenever memoryPolicy !== 'none' - fire-and-forget
// from the caller's side, doesn't block the chat response. No extraction/
// should-save gating here: every turn is stored unconditionally, a
// deliberate v1 scope decision (see the architecture plan's Phase 7) -
// curation/confidence/supersession is a refinement on top of this store,
// not a prerequisite for it being useful.
// Deterministic provenance tag computed by the caller (agent-service's
// safety_net.classify_memory_grounding / chat-orchestrator's
// classifyMemoryGrounding) - memory-engine stays a thin, policy-agnostic
// store and just validates against the known set, same spirit as role
// above. A missing/invalid value defaults to the conservative 'ungrounded'
// rather than trusting an unrecognized value (e.g. mid-rollout version
// skew on a caller that hasn't been redeployed yet).
const ALLOWED_GROUNDING = new Set(["tool_verified", "user_stated", "ungrounded"]);

app.post("/ingest", async (req, res) => {
  const body = req.body as {
    sessionId?: string;
    role?: string;
    content?: string;
    domain?: string;
    taskContextId?: number;
    grounding?: string;
  };
  if (!body.sessionId || typeof body.sessionId !== "string") {
    return res.status(400).json({ error: "sessionId is required" });
  }
  if (body.role !== "user" && body.role !== "assistant") {
    return res.status(400).json({ error: "role must be 'user' or 'assistant'" });
  }
  if (!body.content || typeof body.content !== "string" || !body.content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }
  const grounding = body.grounding && ALLOWED_GROUNDING.has(body.grounding) ? body.grounding : "ungrounded";

  try {
    const embedding = await embedText(config, body.content);
    const entry = await db.insertMemoryEntry(config, {
      sessionId: body.sessionId,
      role: body.role,
      content: body.content,
      embedding,
      domain: body.domain,
      taskContextId: body.taskContextId,
      grounding,
    });
    res.status(201).json({ id: entry.id });
  } catch (e) {
    console.error("failed to ingest memory entry:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Called automatically by chat-orchestrator (in parallel with its Honcho
// peer-card fetch) using the current message as the query, and available
// to the model directly via the memory_recall MCP tool for a deliberate
// mid-conversation check - same backend for both the automatic and
// manual paths. Mirrors knowledge-engine's /search request/response
// shape for consistency across the two "search something we've stored"
// endpoints in this project, even though the underlying tables are
// deliberately separate (user memory vs. world knowledge).
app.post("/search", async (req, res) => {
  const body = req.body as {
    query?: string;
    topK?: number;
    domain?: string;
    taskContextId?: number;
  };
  if (!body.query || typeof body.query !== "string") {
    return res.status(400).json({ error: "query is required" });
  }
  const topK = Number.isInteger(body.topK) && (body.topK as number) > 0 ? Math.min(body.topK as number, 20) : 5;

  try {
    const embedding = await embedText(config, body.query);
    const rows = await db.hybridSearchMemory(config, embedding, body.query, {
      topK,
      domain: body.domain,
      taskContextId: body.taskContextId,
    });
    const results = rows.map((r) => ({
      content: r.content,
      role: r.role,
      sessionId: r.session_id,
      domain: r.domain,
      taskContextId: r.task_context_id,
      createdAt: r.created_at,
      score: r.rrf_score,
      keywordOverlapCount: r.keyword_overlap_count,
      queryLexemeCount: r.query_lexeme_count,
      grounding: r.grounding,
    }));
    res.json({ results });
  } catch (e) {
    console.error("failed to search memory:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`memory-engine listening on :${config.port}`);
});
