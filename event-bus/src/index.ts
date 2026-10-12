import express from "express";
import { loadConfig, type Config } from "./config.js";
import * as db from "./db.js";
import { notifySession } from "./notify.js";
import { ingestEvent } from "./ingest.js";
import { matchGoalsToText } from "./goal-matching.js";
import { pollCalendar } from "./calendar-watch.js";
import { getWorkLevel } from "./work-level.js";
import { runOvernightDigest } from "./digest.js";
import { stepTransitionNotification } from "./step-notifications.js";
import { DIGEST_ALLOWLIST, summarizeEvent } from "./activity.js";

const config = loadConfig(process.env);

const app = express();
app.use(express.json({ limit: "1mb" }));

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "my", "me", "on", "in",
  "at", "with", "about", "into", "track", "goal",
]);

// Same threshold knowledge-engine's research_queue dedup uses
// (config.researchQueueDedupMinOverlap) - short objectives are common
// here too ("wax the car"), so a single shared word is more likely
// coincidence than a real duplicate.
const TASK_CONTEXT_DEDUP_MIN_OVERLAP = 2;

function deriveKeywords(title: string, description?: string): string[] {
  const text = `${title} ${description || ""}`.toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
  return Array.from(new Set(words));
}

// POST /events - ingest, deterministic classification, goal matching, notify.
app.post("/events", async (req, res) => {
  const body = req.body as {
    source?: string;
    type?: string;
    payload?: Record<string, unknown>;
    occurredAt?: string;
    originSessionId?: string;
  };

  if (!body.source || typeof body.source !== "string") {
    return res.status(400).json({ error: "source is required" });
  }
  if (!body.type || typeof body.type !== "string") {
    return res.status(400).json({ error: "type is required" });
  }

  try {
    const event = await ingestEvent(config, {
      source: body.source,
      type: body.type,
      payload: body.payload,
      occurredAt: body.occurredAt,
      originSessionId: body.originSessionId,
    });

    res.status(201).json({ id: event.id });
  } catch (e) {
    console.error("failed to ingest event:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /events?limit=50&source=discord - recent events, newest first. Read
// visibility into the append-only audit trail (every ingested event is
// recorded here even when classify.ts decides not to notify on it) - no
// dashboard has ever existed for this before now (see
// docs/chat-orchestrator.md's dashboard fix for the consumer).
app.get("/events", async (req, res) => {
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;
  const source = typeof req.query.source === "string" ? req.query.source : undefined;
  const type = typeof req.query.type === "string" ? req.query.type : undefined;
  // Amy Lab / Chat's session activity sidebar - filters the same
  // append-only feed down to one conversation.
  const originSessionId = typeof req.query.originSessionId === "string" ? req.query.originSessionId : undefined;

  try {
    const events = await db.listRecentEvents(config, limit, source, type, originSessionId);
    res.json({ events });
  } catch (e) {
    console.error("failed to list events:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /goals - create.
app.post("/goals", async (req, res) => {
  const body = req.body as {
    title?: string;
    description?: string;
    keywords?: string[];
    originSessionId?: string;
  };

  if (!body.title || typeof body.title !== "string") {
    return res.status(400).json({ error: "title is required" });
  }

  try {
    const keywords = body.keywords && body.keywords.length > 0 ? body.keywords : deriveKeywords(body.title, body.description);
    const goal = await db.insertGoal(config, {
      title: body.title,
      description: body.description,
      keywords,
      originSessionId: body.originSessionId,
    });
    res.status(201).json(goal);

    // Deterministic backstop for the self-learning research queue: a newly
    // created persistent goal is, by definition, something the user cares
    // about, so it's worth Amy looking into regardless of whether
    // chat-orchestrator's classifier separately caught the moment (see the
    // "Self-Learning Research Queue" plan's Phase RQ-4). Fire-and-forget,
    // after the response already went out - a slow/unreachable
    // knowledge-engine must never delay or break goal creation itself.
    fetch(`${config.knowledgeEngineUrl}/research-queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: goal.title, originSessionId: goal.origin_session_id ?? undefined, triggerSource: "goal_created" }),
    }).catch((e) => console.error("failed to auto-seed research queue from new goal:", e));

    // Phase 3 of the infrastructure rebuild: a real new goal is exactly the
    // kind of meaningful moment the decision/project/growth ledger exists
    // for - fire-and-forget, same reasoning as the research-queue call
    // above (a slow/unreachable graphiti-service must never delay or
    // break goal creation itself).
    fetch(`${config.graphitiServiceUrl}/episodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: `goal-created-${goal.id}`,
        episodeBody: `The user set a new goal: "${goal.title}".${goal.description ? ` ${goal.description}` : ""}`,
        sourceDescription: "goal_created event",
      }),
    }).catch((e) => console.error("failed to write goal_created episode to graphiti-service:", e));
  } catch (e) {
    console.error("failed to create goal:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /goals?status=active - list.
app.get("/goals", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  try {
    const goals = await db.listGoals(config, status);
    res.json({ goals });
  } catch (e) {
    console.error("failed to list goals:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// PATCH /goals/:id - update; only provided fields change.
app.patch("/goals/:id", async (req, res) => {
  const goalId = Number(req.params.id);
  if (!Number.isInteger(goalId)) {
    return res.status(400).json({ error: "invalid goal id" });
  }
  const body = req.body as { title?: string; description?: string; status?: string; keywords?: string[] };

  try {
    const existing = await db.getGoal(config, goalId);
    if (!existing) {
      return res.status(404).json({ error: `goal ${goalId} not found` });
    }
    const updated = await db.updateGoal(config, goalId, body);
    res.json(updated);
  } catch (e) {
    console.error(`failed to update goal ${goalId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /goals/:id/progress - recent goal_progress_log rows, most recent first.
app.get("/goals/:id/progress", async (req, res) => {
  const goalId = Number(req.params.id);
  if (!Number.isInteger(goalId)) {
    return res.status(400).json({ error: "invalid goal id" });
  }

  try {
    const goal = await db.getGoal(config, goalId);
    if (!goal) {
      return res.status(404).json({ error: `goal ${goalId} not found` });
    }
    const progress = await db.getProgressLog(config, goalId);
    res.json({ goal, progress });
  } catch (e) {
    console.error(`failed to get progress for goal ${goalId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /task-contexts - create. Homed in General (always-on, ungated by
// classification) since a task can span multiple capabilities - see
// docs/chat-workflow.md.
app.post("/task-contexts", async (req, res) => {
  const body = req.body as {
    objective?: string;
    capability?: string;
    domain?: string;
    originSessionId?: string;
    source?: string;
  };

  if (!body.objective || typeof body.objective !== "string") {
    return res.status(400).json({ error: "objective is required" });
  }

  try {
    // Real bug found via live testing: a duplicate "wax the car" task got
    // created with no dedup at all. Returns the existing match instead of
    // erroring - graceful for a tool the model calls autonomously, and
    // task_context_manage's description tells it to check `duplicate` and
    // reuse the id rather than treat this as a failure.
    const existing = await db.findOverlappingOpenTaskContext(config, body.objective, TASK_CONTEXT_DEDUP_MIN_OVERLAP);
    if (existing) {
      return res.json({ ...existing, duplicate: true });
    }

    const taskContext = await db.insertTaskContext(config, {
      objective: body.objective,
      capability: body.capability,
      domain: body.domain,
      originSessionId: body.originSessionId,
      source: body.source,
    });
    res.status(201).json({ ...taskContext, duplicate: false });

    // Feeds the Home activity feed (see activity.ts) - fire after
    // responding, a failure here must never block task creation itself.
    ingestEvent(config, {
      source: "task_context",
      type: "task_context_created",
      payload: { taskContextId: taskContext.id, objective: taskContext.objective },
      originSessionId: body.originSessionId,
      taskContextId: taskContext.id,
    }).catch((e) => console.error(`failed to publish task_context_created for ${taskContext.id}:`, e));
  } catch (e) {
    console.error("failed to create task context:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /task-contexts?status=open - list. status=open means active or
// waiting_for_user (not yet resolved) - this is what the Chat workflow's
// Get Open Task Contexts node calls on every turn.
app.get("/task-contexts", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  try {
    const taskContexts = await db.listTaskContexts(config, status);
    res.json({ taskContexts });
  } catch (e) {
    console.error("failed to list task contexts:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /home-summary - single "what does the user have going on right now"
// snapshot: active goals, open task contexts, and upcoming calendar events,
// combined server-side so any consumer (chat-ui's home dashboard today,
// digest/idle-reflection/self-improvement code later) reads one shape
// instead of re-deriving "open" filtering or re-calling skills-mcp
// separately. Deliberately no new storage - goals/task_contexts are
// already the source of truth in this DB, and calendar events are already
// fetched live (see calendar-watch.ts) rather than mirrored locally.
app.get("/home-summary", async (req, res) => {
  const lookaheadHours = Number(req.query.lookaheadHours) || 24 * 7;

  const [goals, openTasks, calendar] = await Promise.all([
    db.listGoals(config, "active"),
    db.listTaskContexts(config, "open"),
    fetch(`${config.skillsMcpUrl}/internal/calendar-events?lookaheadHours=${lookaheadHours}`)
      .then((r) => (r.ok ? r.json() : { configured: false, events: [] }))
      .catch(() => ({ configured: false, events: [] })) as Promise<{
      configured: boolean;
      events: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string } }>;
    }>,
  ]);

  res.json({
    goals,
    openTasks,
    calendarConfigured: calendar.configured,
    upcomingEvents: calendar.events,
  });
});

// GET /home-activity?limit=20 - the curated, cross-entity "what happened"
// feed for chat-ui's Home page: research done, project created, task
// updated, goal progress (see activity.ts's DIGEST_ALLOWLIST for exactly
// which (source, type) event pairs qualify, plus goal_progress_log read
// directly). Deliberately separate from GET /events (the unscoped
// firehose Chat's debug sidebar still uses) and /home-summary (current
// state, not history).
app.get("/home-activity", async (req, res) => {
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 20;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;

  try {
    const [events, goalProgress] = await Promise.all([
      db.listDigestEvents(config, DIGEST_ALLOWLIST, limit),
      db.listRecentGoalProgress(config, limit),
    ]);

    const items = [
      ...events.map((e) => ({
        id: `event-${e.id}`,
        category: e.source === "research" ? "research" : e.source === "project" ? "project" : "task",
        summary: summarizeEvent(e),
        occurredAt: e.occurred_at,
        taskContextId: e.task_context_id,
      })),
      ...goalProgress.map((g) => ({
        id: `goal-progress-${g.id}`,
        category: "goal",
        summary: `Progress on goal "${g.goal_title}"${g.note ? `: ${g.note}` : ""}.`,
        occurredAt: g.created_at,
        taskContextId: null as number | null,
      })),
    ]
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
      .slice(0, limit);

    res.json({ items });
  } catch (e) {
    console.error("failed to build home activity feed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /task-contexts/match?text=... - scoped relevance injection for the
// chat system prompt, mirroring /goals/match below. Real bug found via
// live dogfooding: GET /task-contexts?status=open (above) was injected
// into every chat turn unconditionally, regardless of topic - this is
// the fix, used only at that one injection point (chat-orchestrator's
// index.ts); the unfiltered listing above stays as-is for other callers
// (e.g. a dashboard) that legitimately want the full open list.
app.get("/task-contexts/match", async (req, res) => {
  const text = typeof req.query.text === "string" ? req.query.text : undefined;
  if (!text) {
    return res.status(400).json({ error: "text query param is required" });
  }
  try {
    const matched = await db.matchOpenTaskContextsToText(config, text);
    res.json({ taskContexts: matched.map((t) => ({ id: t.id, objective: t.objective, status: t.status })) });
  } catch (e) {
    console.error("failed to match task contexts to text:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// PATCH /task-contexts/:id - update; only provided fields change.
app.patch("/task-contexts/:id", async (req, res) => {
  const taskContextId = Number(req.params.id);
  if (!Number.isInteger(taskContextId)) {
    return res.status(400).json({ error: "invalid task context id" });
  }
  const body = req.body as {
    objective?: string;
    capability?: string;
    domain?: string;
    status?: string;
    facts?: unknown[];
    assumptions?: unknown[];
    unknowns?: unknown[];
    nextAction?: string;
  };

  try {
    const existing = await db.getTaskContext(config, taskContextId);
    if (!existing) {
      return res.status(404).json({ error: `task context ${taskContextId} not found` });
    }
    const { nextAction, ...rest } = body;
    const updated = await db.updateTaskContext(config, taskContextId, {
      ...rest,
      ...(nextAction !== undefined ? { next_action: nextAction } : {}),
    });
    res.json(updated);

    // Only a real status transition counts as feed-worthy "task updated" -
    // objective/capability/domain edits are visible in task_context_log's
    // own history (see the per-task detail feed) without adding Home noise.
    if (updated && body.status && body.status !== existing.status) {
      ingestEvent(config, {
        source: "task_context",
        type: "task_context_updated",
        payload: { taskContextId, objective: updated.objective, status: updated.status },
        originSessionId: existing.origin_session_id ?? undefined,
        taskContextId,
      }).catch((e) => console.error(`failed to publish task_context_updated for ${taskContextId}:`, e));
    }
  } catch (e) {
    console.error(`failed to update task context ${taskContextId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /task-contexts/:id/log - append a note, unlike goal_progress_log
// (system-written only via deterministic keyword matching) this is written
// directly by the agent as a task develops.
app.post("/task-contexts/:id/log", async (req, res) => {
  const taskContextId = Number(req.params.id);
  if (!Number.isInteger(taskContextId)) {
    return res.status(400).json({ error: "invalid task context id" });
  }
  const body = req.body as { note?: string };
  if (!body.note || typeof body.note !== "string") {
    return res.status(400).json({ error: "note is required" });
  }

  try {
    const existing = await db.getTaskContext(config, taskContextId);
    if (!existing) {
      return res.status(404).json({ error: `task context ${taskContextId} not found` });
    }
    await db.insertTaskContextLog(config, taskContextId, body.note);
    res.status(201).json({ ok: true });
  } catch (e) {
    console.error(`failed to log task context ${taskContextId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /task-contexts/:id/steps - bulk-create for action='plan'. The
// model proposes every step at once when it decides a task needs
// planning (needsPlanning, see classify-tools.ts), not one at a time.
app.post("/task-contexts/:id/steps", async (req, res) => {
  const taskContextId = Number(req.params.id);
  if (!Number.isInteger(taskContextId)) {
    return res.status(400).json({ error: "invalid task context id" });
  }
  const body = req.body as { descriptions?: string[] };
  if (!Array.isArray(body.descriptions) || body.descriptions.length === 0 || !body.descriptions.every((d) => typeof d === "string" && d.trim())) {
    return res.status(400).json({ error: "descriptions must be a non-empty array of non-empty strings" });
  }

  try {
    const existing = await db.getTaskContext(config, taskContextId);
    if (!existing) {
      return res.status(404).json({ error: `task context ${taskContextId} not found` });
    }
    const steps = await db.insertTaskContextSteps(config, taskContextId, body.descriptions);
    res.status(201).json({ steps });
  } catch (e) {
    console.error(`failed to create steps for task context ${taskContextId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/task-contexts/:id/steps", async (req, res) => {
  const taskContextId = Number(req.params.id);
  if (!Number.isInteger(taskContextId)) {
    return res.status(400).json({ error: "invalid task context id" });
  }
  try {
    const steps = await db.listTaskContextSteps(config, taskContextId);
    res.json({ steps });
  } catch (e) {
    console.error(`failed to list steps for task context ${taskContextId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /task-contexts/:id/activity - the detailed, task-scoped feed behind
// chat-ui's new task detail page: log notes + step status transitions +
// any events tagged with this task (task_context_created/updated),
// merged and sorted oldest-first. Supersedes exposing db.getTaskContextLog
// as its own route - nothing needs the log in isolation from the rest of
// the task's history.
app.get("/task-contexts/:id/activity", async (req, res) => {
  const taskContextId = Number(req.params.id);
  if (!Number.isInteger(taskContextId)) {
    return res.status(400).json({ error: "invalid task context id" });
  }

  try {
    const taskContext = await db.getTaskContext(config, taskContextId);
    if (!taskContext) {
      return res.status(404).json({ error: `task context ${taskContextId} not found` });
    }

    const [log, steps, events] = await Promise.all([
      db.getTaskContextLog(config, taskContextId),
      db.listTaskContextSteps(config, taskContextId),
      db.listEventsForTaskContext(config, taskContextId),
    ]);

    const items = [
      ...log.map((l) => ({ id: `log-${l.id}`, kind: "note" as const, summary: l.note ?? "", occurredAt: l.created_at })),
      ...steps.map((s) => ({
        id: `step-${s.id}`,
        kind: "step" as const,
        summary: `Step ${s.step_index + 1} (${s.description}): ${s.status.replace(/_/g, " ")}`,
        occurredAt: s.updated_at,
      })),
      ...events.map((e) => ({ id: `event-${e.id}`, kind: "event" as const, summary: summarizeEvent(e), occurredAt: e.occurred_at })),
    ].sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());

    res.json({ taskContext, items });
  } catch (e) {
    console.error(`failed to build activity feed for task context ${taskContextId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

async function notifyStepTransition(config: Config, taskContextId: number, step: db.TaskContextStepRow): Promise<void> {
  if (step.status !== "failed" && step.status !== "blocked" && step.status !== "completed") return;

  const task = await db.getTaskContext(config, taskContextId);
  if (!task?.origin_session_id) return;

  const allSteps = await db.listTaskContextSteps(config, taskContextId);
  const message = stepTransitionNotification(step, allSteps, task.objective);
  if (message) await notifySession(config, task.origin_session_id, message);
}

// PATCH /task-contexts/:id/steps/:stepId - action='advance_step'. The
// :id segment isn't just a path convention - it's checked against the
// step's actual task_context_id, so a stale/wrong id from the model
// can't silently update a step under a different task.
app.patch("/task-contexts/:id/steps/:stepId", async (req, res) => {
  const taskContextId = Number(req.params.id);
  const stepId = Number(req.params.stepId);
  if (!Number.isInteger(taskContextId) || !Number.isInteger(stepId)) {
    return res.status(400).json({ error: "invalid task context id or step id" });
  }
  const body = req.body as { status?: string; failurePolicy?: string; toolResult?: unknown };

  try {
    const updated = await db.updateTaskContextStep(config, stepId, {
      status: body.status,
      failure_policy: body.failurePolicy,
      tool_result: body.toolResult,
    });
    if (!updated) {
      return res.status(404).json({ error: `step ${stepId} not found` });
    }
    if (updated.task_context_id !== taskContextId) {
      return res.status(404).json({ error: `step ${stepId} does not belong to task context ${taskContextId}` });
    }
    res.json(updated);

    // Phase 6b: pure templating off a known status transition, no LLM
    // call. Filtered to avoid noise per the architecture plan - failed/
    // blocked always notify immediately (needs attention), completed
    // only notifies once, when it's genuinely the *last* pending step,
    // not on every single step completion along the way.
    notifyStepTransition(config, taskContextId, updated).catch((e) =>
      console.error(`failed to notify step transition for step ${stepId}:`, e),
    );
  } catch (e) {
    console.error(`failed to update step ${stepId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /goals/match?text=... - part of the context-assembly pipeline's
// "relevant goals" injection (see the architecture plan's Phase 4):
// which active goals does this message's text actually match, via the
// same deterministic keyword matcher matchEventToGoals already uses for
// auto-progress-logging. No LLM call - this is a simple string check,
// not a judgment call.
app.get("/goals/match", async (req, res) => {
  const text = typeof req.query.text === "string" ? req.query.text : undefined;
  if (!text) {
    return res.status(400).json({ error: "text query param is required" });
  }
  try {
    const goals = await db.listActiveGoals(config);
    const matched = matchGoalsToText(goals, text);
    res.json({ goals: matched.map((g) => ({ id: g.id, title: g.title, status: g.status })) });
  } catch (e) {
    console.error("failed to match goals to text:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /sessions/:sessionId/last-capability - the Chat workflow's Get Last
// Active Capability node calls this before classification, so an ambiguous
// topic-less follow-up can be kept under the same capability as the
// previous turn. Purely a deterministic read of what the Chat workflow
// itself already published to /events - see db.ts's getLastCapability.
app.get("/sessions/:sessionId/last-capability", async (req, res) => {
  try {
    const capabilities = await db.getLastCapability(config, req.params.sessionId);
    res.json({ capabilities });
  } catch (e) {
    console.error(`failed to get last capability for session ${req.params.sessionId}:`, e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /goals/nudge-check - called by the goalsstalenudge1 n8n Schedule
// Trigger workflow. All real logic lives here, not in n8n - the workflow is
// purely a cron trigger. Deterministic, no LLM: a fixed-template message,
// never an auto status change - the nudge only ever asks a question back
// into the user's own session.
app.post("/goals/nudge-check", async (_req, res) => {
  try {
    const stale = await db.getStaleGoals(config, config.goalStaleDays);
    let notified = 0;
    let skipped = 0;

    for (const goal of stale) {
      if (!goal.origin_session_id) {
        console.log(`nudge-check: skipping goal ${goal.id} ("${goal.title}") - no origin_session_id`);
        skipped++;
        continue;
      }
      const message =
        `Just checking in — your goal "${goal.title}" hasn't had any progress in a while. ` +
        `Still working on it, or should I mark it done/abandoned?`;
      await notifySession(config, goal.origin_session_id, message);
      notified++;
    }

    res.json({ staleCount: stale.length, notified, skipped });
  } catch (e) {
    console.error("failed to run goals nudge-check:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /tasks/nudge-check - same shape and same cron-only-triggers-it
// contract as /goals/nudge-check, extended to task_contexts now that Amy
// can keep a task's facts/nextAction genuinely current via
// task_context_manage's action='update' (see skills-mcp's tool). Including
// nextAction in the message (when she's actually recorded one) is the
// whole point of this nudge over a generic "still working on it?" ping -
// it reflects what Amy actually knows about the task, not just its title.
app.post("/tasks/nudge-check", async (_req, res) => {
  try {
    const stale = await db.getStaleTasks(config, config.taskStaleDays);
    let notified = 0;
    let skipped = 0;

    for (const task of stale) {
      if (!task.origin_session_id) {
        console.log(`nudge-check: skipping task ${task.id} ("${task.objective}") - no origin_session_id`);
        skipped++;
        continue;
      }
      const message = task.next_action
        ? `Just checking in — task #${task.id} ("${task.objective}") hasn't moved in a while. ` +
          `Next step was: ${task.next_action}. Still working on it, or should I mark it done/abandoned?`
        : `Just checking in — task #${task.id} ("${task.objective}") hasn't moved in a while. ` +
          `Still working on it, or should I mark it done/abandoned?`;
      await notifySession(config, task.origin_session_id, message);
      notified++;
    }

    res.json({ staleCount: stale.length, notified, skipped });
  } catch (e) {
    console.error("failed to run tasks nudge-check:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /skill-gap-check - called frequently (every ~15min) by
// skill_gap_scanner's Schedule Trigger, purely to decide WHETHER that
// workflow's expensive Honcho+Ollama reasoning branches should actually run
// this tick. Deterministic counting only, no LLM here - mirrors
// /goals/nudge-check's "n8n is just a cron, all logic lives here" shape.
// Only advances scanner_state.last_run when it says yes, so a "no" tick
// costs one cheap COUNT query and nothing else.
app.post("/skill-gap-check", async (_req, res) => {
  try {
    const lastRun = await db.getScannerLastRun(config, "skill_gap_scanner");
    const messageCount = await db.countEventsSince(config, "chat", "message_received", lastRun);
    const shouldScan = messageCount >= config.skillGapCheckMessages;
    if (shouldScan) {
      await db.touchScannerLastRun(config, "skill_gap_scanner");
    }
    res.json({ shouldScan, messageCount, threshold: config.skillGapCheckMessages });
  } catch (e) {
    console.error("failed to run skill-gap-check:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

function hoursSince(date: Date): number {
  return (Date.now() - date.getTime()) / 3_600_000;
}

// POST /idle-reflection-check - called every ~30min by idlereflection0001's
// Schedule Trigger. Two independent gates, deterministic, no LLM:
// shouldReflect (is it worth running the Honcho+Ollama reasoning at all -
// only when work level is low and enough time has passed) and
// canMessageUser (a separate, stricter cooldown specifically for the
// "message the user directly" outcome - see classify.ts's
// idle_reflection.proactive_thought comment). canMessageUser's own
// scanner_state row only advances via /idle-reflection-messaged, at the
// moment a message actually sends - never here, so a "no" tick never
// consumes the cooldown.
app.post("/idle-reflection-check", async (_req, res) => {
  try {
    const { level } = await getWorkLevel(config);
    if (level === "high") {
      return res.json({ shouldReflect: false, canMessageUser: false, workLevel: "high" });
    }

    const lastRun = await db.getScannerLastRun(config, "idle_reflection");
    const shouldReflect = hoursSince(lastRun) >= config.idleReflectionMinHours;
    if (shouldReflect) {
      await db.touchScannerLastRun(config, "idle_reflection");
    }

    const lastMessaged = await db.getScannerLastRun(config, "idle_reflection_message");
    const canMessageUser = hoursSince(lastMessaged) >= config.idleReflectionMessageMinHours;

    res.json({ shouldReflect, canMessageUser, workLevel: "low" });
  } catch (e) {
    console.error("failed to run idle-reflection-check:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /idle-reflection-messaged - called by idlereflection0001 only right
// after it actually publishes a message_user event, starting the
// idleReflectionMessageMinHours cooldown. Never called for the
// propose_skill outcome - that path doesn't interrupt the user, so it
// doesn't need the same structural cap.
app.post("/idle-reflection-messaged", async (_req, res) => {
  try {
    await db.touchScannerLastRun(config, "idle_reflection_message");
    res.json({ ok: true });
  } catch (e) {
    console.error("failed to mark idle-reflection-messaged:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// POST /calendar/poll-check - called every ~10min by calendarwatch0001's
// Schedule Trigger. All real logic lives here, not in n8n - same
// "n8n is just a cron" shape as /goals/nudge-check and /skill-gap-check.
app.post("/calendar/poll-check", async (_req, res) => {
  try {
    const result = await pollCalendar(config);
    let digest;
    let researchQueue;
    if (result.wakeEventDetected) {
      digest = await runOvernightDigest(config);
      researchQueue = await drainResearchQueueIfIdle(config);
    } else {
      // Real gap found via live testing: the wake-event path above is the
      // only trigger this ever had - with no calendar event titled "wake"
      // ever created, two real topics sat at 'pending' for over a day
      // with zero drain attempts. Independent periodic fallback on this
      // same ~10min poll-check cadence, throttled via the same
      // scanner_state pattern idle-reflection already uses, so draining
      // doesn't depend on maintaining a calendar convention.
      const lastDrain = await db.getScannerLastRun(config, "research_queue_drain");
      if (hoursSince(lastDrain) >= config.researchQueueDrainMinHours) {
        researchQueue = await drainResearchQueueIfIdle(config);
        // Only advance the throttle when a drain actually ran (work level
        // was low) - if skipped for being busy, retry again soon instead
        // of waiting a full researchQueueDrainMinHours more.
        if (!(researchQueue && typeof researchQueue === "object" && "skipped" in researchQueue)) {
          await db.touchScannerLastRun(config, "research_queue_drain");
        }
      }
    }
    res.json({ ...result, digest, researchQueue });
  } catch (e) {
    console.error("failed to run calendar poll-check:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Self-learning research queue drain, triggered either by a calendar wake
// event or the independent periodic fallback above. Gated on work level
// exactly like /idle-reflection-check already is: an active coding task or
// research session already running means Amy is busy, so this defers to
// the next check rather than piling on more background Ollama load.
async function drainResearchQueueIfIdle(config: Config): Promise<{ skipped: string } | unknown> {
  const { level } = await getWorkLevel(config);
  if (level === "high") return { skipped: "work level high" };
  const res = await fetch(`${config.knowledgeEngineUrl}/research-queue/drain`, { method: "POST" });
  if (!res.ok) throw new Error(`research-queue/drain returned ${res.status}`);
  return res.json();
}

// Manual trigger for testing/verification - the real path is
// /calendar/poll-check firing this automatically alongside the digest
// above (same wake event), not a schedule of its own. Separate from
// knowledge-engine's own POST /research-queue/drain (which this calls)
// because the work-level gate lives here, not there.
app.post("/research-queue-check", async (_req, res) => {
  try {
    const result = await drainResearchQueueIfIdle(config);
    res.json(result);
  } catch (e) {
    console.error("failed to run research-queue-check:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// Manual trigger for testing/verification - the real path is
// /calendar/poll-check firing this automatically when a wake-marker
// calendar event is detected starting soon (see calendar-watch.ts's
// isWakeEvent), not a schedule of its own.
app.post("/overnight-digest-check", async (_req, res) => {
  try {
    const result = await runOvernightDigest(config);
    res.json(result);
  } catch (e) {
    console.error("failed to run overnight-digest-check:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`event-bus listening on :${config.port}`);
});
