import express from "express";
import { loadConfig } from "./config.js";
import { runInSandbox, proposePullRequest, type ExecuteRequest, type ProposePrRequest } from "./executor.js";

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

app.listen(config.port, "0.0.0.0", () => {
  console.log(`sandbox-runner listening on :${config.port}`);
});
