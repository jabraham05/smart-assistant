import express from "express";
import { loadConfig } from "./config.js";
import * as db from "./db.js";
import { classify } from "./classify.js";
import { matchEventToGoals } from "./goal-matching.js";
import { notifySession } from "./notify.js";
import { notifyOwnerDirect } from "./discord-notify.js";
import { buildEventMessage } from "./message-templates.js";

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
    const event = await db.insertEvent(config, {
      source: body.source,
      type: body.type,
      payload: body.payload,
      occurredAt: body.occurredAt,
      originSessionId: body.originSessionId,
    });

    const { priority, notify } = classify(event.source, event.type);
    await db.updateEventClassification(config, event.id, { priority, should_notify: notify });

    await matchEventToGoals(config, event);

    if (notify && event.origin_session_id) {
      await notifySession(config, event.origin_session_id, buildEventMessage(event));
      await db.markEventStatus(config, event.id, "notified", true);
    } else if (notify) {
      await db.markEventStatus(config, event.id, "notify_skipped_no_session");
    } else if (priority === "high" && !event.origin_session_id) {
      // Orphaned high-priority event: no session to reply into, and (per
      // classify.ts) no source-level notification already covers it either
      // (that's what notify:false means for these rules - the source
      // handles the has-session case itself). Without this, an event like a
      // CLI-triggered coding task's task_needs_review/task_resource_limit
      // (see scripts/start-coding-task.mjs) would silently vanish - there's
      // no chat session to write into and nothing else watching. Escalate
      // via a direct DM instead of dropping it.
      await notifyOwnerDirect(config, buildEventMessage(event));
      await db.markEventStatus(config, event.id, "notified", true);
    } else {
      await db.markEventStatus(config, event.id, "processed");
    }

    res.status(201).json({ id: event.id });
  } catch (e) {
    console.error("failed to ingest event:", e);
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

app.listen(config.port, "0.0.0.0", () => {
  console.log(`event-bus listening on :${config.port}`);
});
