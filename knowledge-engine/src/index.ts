import express from "express";
import { loadConfig } from "./config.js";
import {
  checkSchema,
  getResearchSessionDetail,
  getLatestResearchSessionByOriginSession,
  insertResearchSession,
  listResearchQueue,
  findResearchQueueByTopic,
  findResearchSessionByTopic,
  insertProject,
  listProjects,
  getProject,
  updateProject,
  getResearchQueueEntry,
  findOverlappingProject,
  getEntity,
  listEntities,
  updateEntity,
} from "./db.js";
import { ingestDocument } from "./engine/ingest.js";
import { search } from "./engine/search.js";
import { checkKnowledge, runWebResearchAndPersist } from "./engine/research.js";
import { enqueueTopic, drainQueue } from "./engine/research-queue.js";
import { consolidateProject, consolidateFromExistingKnowledge } from "./engine/consolidate.js";
import { startCodingTask, getCodingTask } from "./lib/coding-orchestrator-client.js";
import { createEntity, readEntityFile } from "./engine/entities.js";

const config = loadConfig(process.env);

const app = express();
// Generous limit: a base64-encoded PDF manual sent via /documents/ingest
// runs well past express's 100kb default (a real multi-hundred-page manual,
// base64-inflated ~33%, can land in the tens of MB).
app.use(express.json({ limit: "150mb" }));

// Same threshold research_queue's own dedup uses (config.researchQueueDedupMinOverlap)
// - project titles are similarly short, so a single shared word is more
// likely coincidence than a real duplicate.
const PROJECT_DEDUP_MIN_OVERLAP = 2;

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

// POST /research - deterministic knowledge-vs-web routing, always
// synchronous for the fast half (checkKnowledge). A web escalation is
// genuinely slow (a real agent run took over a minute in Phase 3 testing)
// - too slow to block an MCP tool call - so that half responds immediately
// with an ack + sessionId and runs the actual agent loop + persistence in
// the background (not awaited by this handler), same "ack immediately,
// keep working after" shape research_pipeline's own onReceived webhook
// trigger used. Callers poll GET /research/status for completion.
app.post("/research", async (req, res) => {
  const body = req.body as {
    query?: string;
    domain?: string;
    triggerSource?: string;
    originSessionId?: string;
    deferNotify?: boolean;
  };

  if (!body.query || typeof body.query !== "string") {
    return res.status(400).json({ error: "query is required" });
  }

  const input = {
    query: body.query,
    domain: body.domain,
    triggerSource: body.triggerSource,
    originSessionId: body.originSessionId,
    deferNotify: body.deferNotify === true,
  };

  try {
    const { route, knowledgeResults } = await checkKnowledge(config, input);

    if (route.source === "knowledge") {
      return res.json({ route, knowledgeResults });
    }

    if (!config.tavilyApiKey) {
      return res.status(500).json({ error: "web escalation needed but TAVILY_API_KEY is not configured" });
    }

    const session = await insertResearchSession(config, {
      topic: input.query,
      domain: input.domain,
      triggerSource: input.triggerSource,
      originSessionId: input.originSessionId,
    });
    res.json({ route, knowledgeResults: [], sessionId: session.id, status: "running" });

    // Deliberately not awaited - the HTTP response above already went out.
    // Errors are caught and recorded on the session row inside
    // runWebResearchAndPersist itself, not here.
    void runWebResearchAndPersist(config, input, session.id);
  } catch (e) {
    console.error("failed to research:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  }
});

// GET /research/status?sessionId=<chat session id> - same pattern as the
// old research_task_status: latest research run started from this chat
// session, for a mid-conversation progress check. OR
// GET /research/status?topic=<topic> - real gap found via live testing:
// background research queued ambiently (research-queue.ts) and drained
// hours/overnight later is invisible to a session-scoped lookup once the
// user asks about it from a different or later conversation, even though
// the research genuinely completed. topic search checks research_queue
// first (covers pending/researching/failed, and done items via their
// research_session_id), falling back to research_sessions directly for
// anything researched via the older research_task path that never went
// through the queue at all. sessionId and topic are mutually exclusive;
// topic wins if both are somehow given.
//
// Registered BEFORE /research/:id deliberately - Express matches routes in
// registration order, and a parameterized /research/:id would otherwise
// greedily match "status" as the :id value, intercepting every request
// here before it ever reached this handler. Caught live: this route
// returned {"error":"invalid research session id"} (the OTHER handler's
// error) instead of ever running its own body, until the order was fixed.
app.get("/research/status", async (req, res) => {
  const topic = typeof req.query.topic === "string" ? req.query.topic : undefined;
  const originSessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  if (!topic && !originSessionId) {
    return res.status(400).json({ error: "sessionId or topic query param is required" });
  }

  try {
    if (topic) {
      const queueMatch = await findResearchQueueByTopic(config, topic, config.researchQueueDedupMinOverlap);
      if (queueMatch) {
        if (queueMatch.status === "done" && queueMatch.research_session_id) {
          const detail = await getResearchSessionDetail(config, queueMatch.research_session_id);
          if (detail) {
            return res.json({
              found: true,
              status: detail.session.status,
              topic: detail.session.topic,
              sessionId: detail.session.id,
              documentId: detail.session.document_id,
              findings: detail.findings,
            });
          }
        }
        return res.json({ found: true, status: queueMatch.status, topic: queueMatch.topic });
      }
      const sessionMatch = await findResearchSessionByTopic(config, topic, config.researchQueueDedupMinOverlap);
      if (!sessionMatch) return res.json({ found: false });
      return res.json({
        found: true,
        status: sessionMatch.status,
        topic: sessionMatch.topic,
        sessionId: sessionMatch.id,
        documentId: sessionMatch.document_id,
      });
    }

    const session = await getLatestResearchSessionByOriginSession(config, originSessionId!);
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

// POST /research-queue - enqueue a topic for the self-learning research
// queue. Called ambiently by chat-orchestrator (Coordinator-detected
// knowledge gaps) and deterministically by event-bus (every new goal - see
// event-bus/src/index.ts's POST /goals). Dedup/already-known/queue-depth
// gating all happens inside enqueueTopic - this handler is a thin wrapper.
app.post("/research-queue", async (req, res) => {
  const body = req.body as { topic?: string; domain?: string; originSessionId?: string; triggerSource?: string };
  if (!body.topic || typeof body.topic !== "string") {
    return res.status(400).json({ error: "topic is required" });
  }
  try {
    const result = await enqueueTopic(config, {
      topic: body.topic,
      domain: body.domain,
      originSessionId: body.originSessionId,
      triggerSource: body.triggerSource,
    });
    res.json(result);
  } catch (e) {
    console.error("failed to enqueue research topic:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /research-queue?status= - list, for debugging/ops. No chat-invoked
// tool wraps this yet - see the plan's "explicitly deferred" note.
app.get("/research-queue", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  try {
    const queue = await listResearchQueue(config, status);
    res.json({ queue });
  } catch (e) {
    console.error("failed to list research queue:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /research-queue/drain - called by event-bus's wake-event trigger
// (POST /calendar/poll-check), gated there on work-level. Also a manual
// test entry point, same "real automatic trigger + standalone manual hit"
// shape as /overnight-digest-check.
app.post("/research-queue/drain", async (req, res) => {
  const body = req.body as { limit?: number };
  const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : config.researchQueueDrainLimit;
  try {
    const result = await drainQueue(config, limit);
    res.json(result);
  } catch (e) {
    console.error("failed to drain research queue:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /projects - propose a project (Amy, via skills-mcp's
// project_propose tool, or a human directly). Always starts 'proposed' -
// see docs/knowledge-engine.md's dated entry for why there's no
// user_requested fast-path to 'active'.
app.post("/projects", async (req, res) => {
  const body = req.body as {
    title?: string;
    rationale?: string;
    domain?: string;
    origin?: string;
    activityType?: string;
    targetRepoUrl?: string;
  };
  if (!body.title || typeof body.title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }
  if (!body.rationale || typeof body.rationale !== "string") {
    return res.status(400).json({ error: "rationale is required" });
  }
  if (body.activityType && body.activityType !== "research" && body.activityType !== "coding") {
    return res.status(400).json({ error: "activityType must be 'research' or 'coding'" });
  }
  try {
    // Real bug found via live testing: duplicate projects got created for
    // the same idea with no dedup at all. Returns the existing match
    // instead of erroring - graceful for a tool the model calls
    // autonomously (project_propose surfaces `duplicate` to the model so
    // it reuses the id rather than treating this as a failure).
    const existing = await findOverlappingProject(config, body.title, PROJECT_DEDUP_MIN_OVERLAP);
    if (existing) {
      return res.json({ ...existing, duplicate: true });
    }

    const project = await insertProject(config, {
      title: body.title,
      rationale: body.rationale,
      domain: body.domain,
      origin: body.origin,
      activityType: body.activityType,
      targetRepoUrl: body.targetRepoUrl,
    });
    res.status(201).json({ ...project, duplicate: false });

    // Feeds the Home activity feed (see event-bus's activity.ts) -
    // fire-and-forget, same pattern as notify.ts's logAwaitingDigest.
    fetch(`${config.eventBusUrl}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "project",
        type: "project_created",
        payload: { projectId: project.id, title: project.title, activityType: project.activity_type },
      }),
    }).catch((e) => console.error(`failed to publish project_created for project ${project.id}:`, e));
  } catch (e) {
    console.error("failed to create project:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /projects?status= - list, for the /amy dashboard.
app.get("/projects", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  try {
    const projects = await listProjects(config, status);
    res.json({ projects });
  } catch (e) {
    console.error("failed to list projects:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /projects/:id/approve - the human review gate. Branches on
// activity_type: 'research' enqueues the project's title as a
// research_queue topic in-process (same import the research-queue routes
// already use, no HTTP hop since they share this service/database);
// 'coding' calls coding-orchestrator directly (a different service, so
// this one IS a real HTTP hop - see lib/coding-orchestrator-client.ts).
app.post("/projects/:id/approve", async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) {
    return res.status(400).json({ error: "invalid project id" });
  }
  try {
    const project = await getProject(config, projectId);
    if (!project) return res.status(404).json({ error: `project ${projectId} not found` });
    if (project.status !== "proposed") {
      return res.status(409).json({ error: `project ${projectId} is not proposed (status: ${project.status})` });
    }

    // Phase 3 of the infrastructure rebuild: the human deciding to approve
    // a project is exactly the kind of meaningful moment the decision/
    // project/growth ledger exists for - true regardless of which path
    // below actually resolves it (coding, research, already-known), so
    // fired once here rather than duplicated in every branch. Fire-and-
    // forget - a slow/unreachable graphiti-service must never delay or
    // break project approval itself.
    fetch(`${config.graphitiServiceUrl}/episodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `project-approved-${project.id}`,
        episodeBody: `The user approved the project "${project.title}" (${project.activity_type}). Rationale: ${project.rationale}`,
        sourceDescription: "project_approved event",
      }),
    }).catch((e) => console.error(`failed to write project_approved episode for project ${project.id}:`, e));

    if (project.activity_type === "coding") {
      const { taskId } = await startCodingTask(config, {
        task: project.rationale,
        repoUrl: project.target_repo_url ?? undefined,
      });
      const updated = await updateProject(config, projectId, {
        status: "active",
        approvedAt: new Date(),
        codingTaskId: taskId,
      });
      return res.json(updated);
    }

    const enqueueResult = await enqueueTopic(config, {
      topic: project.title,
      domain: project.domain ?? undefined,
      triggerSource: "project_approved",
    });

    if (enqueueResult.queued && enqueueResult.id !== undefined) {
      const updated = await updateProject(config, projectId, {
        status: "active",
        approvedAt: new Date(),
        researchQueueId: enqueueResult.id,
      });
      return res.json(updated);
    }

    // Two real dead ends found via live testing, both fixed the same way:
    // approving a project whose topic is already well-covered, or already
    // queued/overlapping an unrelated queue entry, used to just 409 with
    // no path forward. Both cases mean the work is effectively already
    // done or already in flight - finish or adopt it instead of failing.
    if (enqueueResult.alreadyKnown) {
      const result = await consolidateFromExistingKnowledge(config, project, enqueueResult.knowledgeResults ?? []);
      const updated = await getProject(config, projectId);
      return res.json({ ...updated, documentId: result.documentId });
    }
    if (enqueueResult.existingQueueId !== undefined) {
      const updated = await updateProject(config, projectId, {
        status: "active",
        approvedAt: new Date(),
        researchQueueId: enqueueResult.existingQueueId,
      });
      return res.json(updated);
    }

    // A genuine transient failure (e.g. queue is full) - nothing to adopt,
    // no knowledge to consolidate from. Honest 409, not a silent 'active'
    // with no research actually scheduled.
    return res.status(409).json({ error: `couldn't schedule research: ${enqueueResult.reason}` });
  } catch (e) {
    console.error(`failed to approve project ${projectId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /projects/:id/reject
app.post("/projects/:id/reject", async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) {
    return res.status(400).json({ error: "invalid project id" });
  }
  try {
    const project = await getProject(config, projectId);
    if (!project) return res.status(404).json({ error: `project ${projectId} not found` });
    const updated = await updateProject(config, projectId, { status: "rejected" });
    res.json(updated);
  } catch (e) {
    console.error(`failed to reject project ${projectId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /projects/:id/complete - the consolidation trigger. Synchronous:
// one bounded ollamaChat() call, not a multi-step agent run, so a
// dashboard button click can wait on it (see docs/knowledge-engine.md).
// Branches on activity_type for the "is this actually ready" check;
// consolidateProject() itself branches again for the synthesis step.
app.post("/projects/:id/complete", async (req, res) => {
  const projectId = Number(req.params.id);
  if (!Number.isInteger(projectId)) {
    return res.status(400).json({ error: "invalid project id" });
  }
  try {
    const project = await getProject(config, projectId);
    if (!project) return res.status(404).json({ error: `project ${projectId} not found` });
    if (project.status !== "active") {
      return res.status(409).json({ error: `project ${projectId} is not active (status: ${project.status})` });
    }

    if (project.activity_type === "coding") {
      if (!project.coding_task_id) {
        return res.status(409).json({ error: "project has no linked coding task" });
      }
      const task = await getCodingTask(config, project.coding_task_id);
      if (!task) {
        return res.status(409).json({ error: `coding task ${project.coding_task_id} not found` });
      }
      if (task.status === "needs_review_failed" || task.status === "resource_limit_reached") {
        // A real terminal failure, not "still working" - surface the
        // reason instead of looping as "not finished yet" forever (same
        // gap fixed below for the research branch).
        return res.status(409).json({
          error: `coding task failed (${task.status}): ${task.reviewer_reason || task.latest_status || "no reason recorded"}`,
        });
      }
      if (task.status !== "proposed") {
        // coding_tasks' own meaning of 'proposed': Reviewer approved,
        // diff/PR ready - not to be confused with projects.status='proposed'
        // (awaiting approval to start), a different state machine entirely.
        return res.status(409).json({ error: "coding task not finished yet" });
      }
    } else {
      let researchSessionId = project.research_session_id ?? undefined;
      if (!researchSessionId) {
        if (!project.research_queue_id) {
          return res.status(409).json({ error: "project has no linked research queue entry" });
        }
        const queueEntry = await getResearchQueueEntry(config, project.research_queue_id);
        if (!queueEntry) {
          return res.status(409).json({ error: "linked research queue entry not found" });
        }
        if (queueEntry.status === "failed") {
          return res.status(409).json({ error: "research failed - no findings to consolidate" });
        }
        if (queueEntry.status !== "done" || !queueEntry.research_session_id) {
          return res.status(409).json({ error: "research not finished yet" });
        }
        researchSessionId = queueEntry.research_session_id;
        await updateProject(config, projectId, { researchSessionId });
      }
    }

    const result = await consolidateProject(config, projectId);
    const updated = await getProject(config, projectId);
    res.json({ ...updated, documentId: result.documentId });
  } catch (e) {
    console.error(`failed to complete project ${projectId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /entities - Phase 1 of the "Amy's world" rework (23-create-entities-
// table.sql / engine/entities.ts): register a durable thing and write its
// backing file. Currently only called from consolidate.ts on project
// completion - no chat-invoked tool wraps this yet, same "infra first,
// tool wiring later" shape research-queue's own GET endpoint followed.
app.post("/entities", async (req, res) => {
  const body = req.body as {
    type?: string;
    name?: string;
    description?: string;
    status?: string;
    sourceTable?: string;
    sourceId?: string;
    metadata?: Record<string, unknown>;
  };
  if (!body.type || typeof body.type !== "string") {
    return res.status(400).json({ error: "type is required" });
  }
  if (!body.name || typeof body.name !== "string") {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    const entity = await createEntity(config, {
      type: body.type,
      name: body.name,
      description: body.description,
      status: body.status,
      sourceTable: body.sourceTable,
      sourceId: body.sourceId,
      metadata: body.metadata,
    });
    res.status(201).json(entity);
  } catch (e) {
    console.error("failed to create entity:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /entities?type= - list, for debugging/ops, same pattern as GET
// /research-queue.
app.get("/entities", async (req, res) => {
  const type = typeof req.query.type === "string" ? req.query.type : undefined;
  try {
    const entities = await listEntities(config, type);
    res.json({ entities });
  } catch (e) {
    console.error("failed to list entities:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Includes the backing file's raw content (undefined if the entity has no
// source_path or the file is missing) - the one piece GET /entities (list)
// deliberately omits, since the dashboard's list view only needs it once a
// specific entity is selected (see chat-ui's EntitiesView).
app.get("/entities/:id", async (req, res) => {
  try {
    const entity = await getEntity(config, req.params.id);
    if (!entity) return res.status(404).json({ error: `entity ${req.params.id} not found` });
    const content = await readEntityFile(config, entity);
    res.json({ ...entity, content: content ?? null });
  } catch (e) {
    console.error(`failed to get entity ${req.params.id}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.patch("/entities/:id", async (req, res) => {
  const body = req.body as Partial<{
    status: string;
    description: string;
    sourcePath: string;
    graphitiId: string;
    metadata: Record<string, unknown>;
  }>;
  try {
    const entity = await updateEntity(config, req.params.id, body);
    if (!entity) return res.status(404).json({ error: `entity ${req.params.id} not found` });
    res.json(entity);
  } catch (e) {
    console.error(`failed to update entity ${req.params.id}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`knowledge-engine listening on :${config.port}`);
});
