"""FastAPI wrapper around task_runner.py - the HTTP surface coding-
orchestrator calls instead of its own internal Coder/Tester agent-loop.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI
from pydantic import BaseModel

from .config import load_config
from .task_runner import propose_pr, run_task

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

config = load_config()
app = FastAPI()


class RunTaskRequest(BaseModel):
    taskId: int
    taskDescription: str
    repoUrl: str
    ref: str = "main"
    testCommand: str


class RunTaskResponse(BaseModel):
    diff: str
    testExitCode: int
    testOutput: str
    success: bool
    summary: str
    attempts: int


@app.post("/run-task", response_model=RunTaskResponse)
async def run_task_endpoint(req: RunTaskRequest):
    result = run_task(config, req.taskId, req.taskDescription, req.repoUrl, req.ref, req.testCommand)
    return RunTaskResponse(
        diff=result.diff,
        testExitCode=result.test_exit_code,
        testOutput=result.test_output,
        success=result.success,
        summary=result.summary,
        attempts=result.attempts,
    )


class ProposePrRequest(BaseModel):
    repoUrl: str
    ref: str = "main"
    branchName: str
    diff: str


class ProposePrResponse(BaseModel):
    pushed: bool
    prUrl: str | None
    error: str | None


@app.post("/propose-pr", response_model=ProposePrResponse)
async def propose_pr_endpoint(req: ProposePrRequest):
    pushed, pr_url, error = propose_pr(config, req.repoUrl, req.ref, req.branchName, req.diff)
    return ProposePrResponse(pushed=pushed, prUrl=pr_url, error=error)


@app.get("/health")
async def health():
    return {"status": "ok"}
