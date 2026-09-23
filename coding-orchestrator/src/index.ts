import express from "express";
import { loadConfig } from "./config.js";
import * as db from "./db.js";
import { runTaskPipeline } from "./pipeline.js";

const config = loadConfig(process.env);

const app = express();
app.use(express.json({ limit: "5mb" }));

app.post("/task", async (req, res) => {
  const body = req.body as { task?: string; repoUrl?: string; ref?: string; testCommand?: string; chatSessionId?: string };

  if (!body.task || typeof body.task !== "string") {
    return res.status(400).json({ error: "task is required" });
  }

  try {
    const taskId = await db.insertTask(config, {
      task: body.task,
      repoUrl: body.repoUrl,
      ref: body.ref,
      testCommand: body.testCommand,
      chatSessionId: body.chatSessionId,
    });

    // Fire-and-forget, matching the old webhook's onReceived/immediate-ack
    // behavior: the caller gets a response right away, the actual pipeline
    // runs in the background.
    runTaskPipeline(config, taskId).catch((e) => {
      console.error(`coding task ${taskId}: unhandled pipeline error:`, e);
    });

    res.json({ message: "Task started", taskId });
  } catch (e) {
    console.error("failed to start coding task:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/task/status", async (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  if (!sessionId) {
    return res.status(400).json({ error: "sessionId query param is required" });
  }

  try {
    const row = await db.getLatestTaskForSession(config, sessionId);
    if (!row) {
      return res.json({ found: false });
    }
    res.json({
      found: true,
      status: row.status,
      latestStatus: row.latest_status,
      attemptCount: row.attempt_count,
      prUrl: row.pr_url || undefined,
      taskDescription: row.task_description,
    });
  } catch (e) {
    console.error("failed to look up coding task status:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /tasks?status=&limit= - list, for chat-ui's /amy dashboard (Coding
// Tasks card) and knowledge-engine's project-completion check for
// coding-activity projects. No list capability existed before this - only
// "create one" and "check one task's own status by session".
app.get("/tasks", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  try {
    const tasks = await db.listTasks(config, status, limit);
    res.json({ tasks });
  } catch (e) {
    console.error("failed to list coding tasks:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// GET /tasks/:id - single task by id (not by session), for
// knowledge-engine's project-completion check.
app.get("/tasks/:id", async (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId)) {
    return res.status(400).json({ error: "invalid task id" });
  }
  try {
    const task = await db.getTask(config, taskId);
    res.json(task);
  } catch (e) {
    res.status(404).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`coding-orchestrator listening on :${config.port}`);
});
