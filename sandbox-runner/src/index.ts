import express from "express";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.js";
import {
  runInSandbox,
  proposePullRequest,
  createTaskContainer,
  execInTaskContainer,
  diffTaskContainer,
  destroyTaskContainer,
  startTaskContainerReaper,
  TaskContainerNotFoundError,
  type ExecuteRequest,
  type ProposePrRequest,
  type CreateTaskContainerRequest,
} from "./executor.js";

const config = loadConfig(process.env);

const app = express();
app.use(express.json({ limit: "5mb" })); // patches can be sizeable diffs

app.post("/execute", async (req, res) => {
  const body = req.body as Partial<ExecuteRequest>;

  if (!body.repoUrl || typeof body.repoUrl !== "string") {
    return res.status(400).json({ error: "repoUrl is required" });
  }
  if (!body.testCommand || typeof body.testCommand !== "string") {
    return res.status(400).json({ error: "testCommand is required" });
  }

  try {
    const result = await runInSandbox(config, {
      repoUrl: body.repoUrl,
      ref: body.ref,
      patch: body.patch,
      testCommand: body.testCommand,
      timeoutSeconds: body.timeoutSeconds,
    });
    res.json(result);
  } catch (e) {
    console.error("sandbox execution failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/propose-pr", async (req, res) => {
  const body = req.body as Partial<ProposePrRequest>;

  if (!body.repoUrl || typeof body.repoUrl !== "string") {
    return res.status(400).json({ error: "repoUrl is required" });
  }
  if (!body.patch || typeof body.patch !== "string") {
    return res.status(400).json({ error: "patch is required" });
  }
  if (!body.branchName || typeof body.branchName !== "string") {
    return res.status(400).json({ error: "branchName is required" });
  }
  if (!body.commitMessage || typeof body.commitMessage !== "string") {
    return res.status(400).json({ error: "commitMessage is required" });
  }
  if (!body.prTitle || typeof body.prTitle !== "string") {
    return res.status(400).json({ error: "prTitle is required" });
  }

  try {
    const result = await proposePullRequest(config, {
      repoUrl: body.repoUrl,
      baseRef: body.baseRef,
      patch: body.patch,
      branchName: body.branchName,
      commitMessage: body.commitMessage,
      prTitle: body.prTitle,
      prBody: body.prBody,
    });
    res.json(result);
  } catch (e) {
    console.error("propose-pr failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- Persistent task containers (agentic coding pipeline) ---
// Unlike /execute and /propose-pr above, these calls target one specific
// long-lived container across a task's whole lifetime. The caller (n8n)
// is responsible for carrying `taskId`/`workingDir` forward from /task's
// response into every subsequent call for that task.

app.post("/task", async (req, res) => {
  const body = req.body as Partial<CreateTaskContainerRequest>;

  if (!body.repoUrl || typeof body.repoUrl !== "string") {
    return res.status(400).json({ error: "repoUrl is required" });
  }

  try {
    const result = await createTaskContainer(config, {
      repoUrl: body.repoUrl,
      ref: body.ref,
      projectFolder: body.projectFolder,
      taskId: body.taskId || randomUUID(),
    });
    res.json(result);
  } catch (e) {
    console.error("createTaskContainer failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/task/:id/exec", async (req, res) => {
  const body = req.body as { command?: string; workingDir?: string; timeoutSeconds?: number };

  if (!body.command || typeof body.command !== "string") {
    return res.status(400).json({ error: "command is required" });
  }
  if (!body.workingDir || typeof body.workingDir !== "string") {
    return res.status(400).json({ error: "workingDir is required" });
  }

  try {
    const result = await execInTaskContainer(config, {
      containerId: req.params.id,
      workingDir: body.workingDir,
      command: body.command,
      timeoutSeconds: body.timeoutSeconds,
    });
    res.json(result);
  } catch (e) {
    if (e instanceof TaskContainerNotFoundError) {
      return res.status(404).json({ error: e.message });
    }
    console.error("execInTaskContainer failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/task/:id/diff", async (req, res) => {
  const workingDir = typeof req.query.workingDir === "string" ? req.query.workingDir : undefined;
  if (!workingDir) {
    return res.status(400).json({ error: "workingDir query param is required" });
  }

  try {
    const result = await diffTaskContainer(config, { containerId: req.params.id, workingDir });
    res.json(result);
  } catch (e) {
    if (e instanceof TaskContainerNotFoundError) {
      return res.status(404).json({ error: e.message });
    }
    console.error("diffTaskContainer failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.delete("/task/:id", async (req, res) => {
  try {
    await destroyTaskContainer(config, req.params.id);
    res.json({ removed: true });
  } catch (e) {
    console.error("destroyTaskContainer failed:", e);
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

startTaskContainerReaper(config);

app.listen(config.port, "0.0.0.0", () => {
  console.log(`sandbox-runner listening on :${config.port}`);
});
