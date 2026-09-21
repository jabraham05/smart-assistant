import express from "express";
import { loadConfig } from "./config.js";
import * as db from "./db.js";
import { notifySession } from "./notify.js";
import { ingestEvent } from "./ingest.js";
import { pollCalendar } from "./calendar-watch.js";
import { getWorkLevel } from "./work-level.js";

const config = loadConfig(process.env);

const app = express();
app.use(express.json({ limit: "1mb" }));

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "and", "or", "my", "me", "on", "in",
  "at", "with", "about", "into", "track", "goal",
]);

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

  try {
    const events = await db.listRecentEvents(config, limit, source);
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
    res.json(result);
  } catch (e) {
    console.error("failed to run calendar poll-check:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`event-bus listening on :${config.port}`);
});
