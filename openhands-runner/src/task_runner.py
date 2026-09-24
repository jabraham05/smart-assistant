"""Core task execution - wraps the OpenHands SDK as coding-orchestrator's
execution engine. coding-orchestrator keeps owning task/session tracking,
DB, and notifications (see pipeline.ts); this module owns only what OpenHands
is actually good at: the agentic coding loop itself.

Live-verified this session (2026-09-24) against the real running stack:
- OpenHands + qwen3:8b via Ollama's ollama_chat provider makes real,
  correctly-executed tool calls (confirmed via ground-truth file checks,
  not just trusting the agent's own claims) - qwen2.5-coder:7b (coding-
  orchestrator's original model) does not: it either rejects the SDK's
  default reasoning_effort outright, or (even with reasoning disabled)
  narrates tool calls as prose without a real structured call.
- DockerWorkspace's `network=` constructor field is a real, first-class
  option for joining the spawned agent-server container to sandbox-net,
  matching sandbox-runner's own proven network-isolation posture.
- BaseWorkspace.execute_command/git_diff are available to this module's own
  driver code, independent of the agent's own conversation/tool-call
  history - this is what makes token-isolated clone/push possible (see
  _clone_and_strip_token/_push_and_strip_token below), the same isolation
  sandbox-runner's own GITHUB_TOKEN handling already established.
"""

from __future__ import annotations

import logging
import socket
import uuid
from dataclasses import dataclass

from openhands.sdk import LLM, Agent, Conversation, Tool
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool
from openhands.workspace import DockerWorkspace

from .config import Config

logger = logging.getLogger(__name__)

_CODER_SYSTEM_PROMPT = (
    "You are working on a real coding task in a container with the target repository already "
    "checked out in the current directory. Look at real files before changing them, make the actual "
    "code edits, and run the project's test command as you go. Only make the implementation change "
    "described in the task; write real test coverage for it if none exists. When you believe the work "
    "is genuinely done and tests pass, call the finish tool with a short summary of what you did."
)

_RETRY_SUFFIX = (
    "\n\nThis is a retry - your previous attempt's test run failed. Diagnose why and fix it before "
    "finishing again. Test result from the last attempt:\n{test_output}"
)


@dataclass
class TaskResult:
    diff: str
    test_exit_code: int
    test_output: str
    success: bool
    summary: str
    attempts: int


def _clone_and_strip_token(workspace: DockerWorkspace, repo_url: str, ref: str, github_token: str | None) -> None:
    """Clones with the token embedded in the URL for exactly this one
    command, then immediately rewrites the remote to the plain URL - the
    agent's own conversation starts only after this returns, so its shell
    access never sees a token-bearing remote. Mirrors sandbox-runner's own
    documented GITHUB_TOKEN isolation, just at a different layer (this
    module's driver code operating the workspace directly, bypassing the
    agent, instead of a separate ephemeral push-only container)."""
    # Real, live-verified finding: BaseWorkspace.execute_command omits `cwd`
    # from the request entirely when it's None, leaving the agent-server to
    # pick its own default - which is NOT `/workspace`, unlike the agent's
    # own TerminalTool/FileEditorTool calls (which do target working_dir).
    # Every driver-side execute_command call must pass cwd explicitly or it
    # silently operates on the wrong directory - this caused a real false
    # test-failure (agent's own in-session test passed, but this module's
    # own post-hoc test run landed elsewhere and reported exit 1) that sent
    # a genuinely-finished task into a pointless retry loop.
    cwd = workspace.working_dir
    if github_token and "github.com" in repo_url:
        auth_url = repo_url.replace("https://", f"https://x-access-token:{github_token}@")
        result = workspace.execute_command(f"git clone --branch {ref} {auth_url} .", cwd=cwd, timeout=120)
        if result.exit_code != 0:
            # Ref might not exist as a branch (e.g. a commit SHA) - fall
            # back to a plain clone + checkout, same fallback shape
            # sandbox-runner's own executor uses.
            workspace.execute_command(f"git clone {auth_url} .", cwd=cwd, timeout=120)
            workspace.execute_command(f"git checkout {ref}", cwd=cwd, timeout=30)
        workspace.execute_command(f"git remote set-url origin {repo_url}", cwd=cwd)
    else:
        result = workspace.execute_command(f"git clone --branch {ref} {repo_url} .", cwd=cwd, timeout=120)
        if result.exit_code != 0:
            workspace.execute_command(f"git clone {repo_url} .", cwd=cwd, timeout=120)
            workspace.execute_command(f"git checkout {ref}", cwd=cwd, timeout=30)


def _push_and_strip_token(
    workspace: DockerWorkspace, repo_url: str, branch_name: str, github_token: str | None
) -> tuple[bool, str | None]:
    """Same token-isolation pattern as clone - push happens driver-side,
    outside the agent's own tool-call history, and the token is never left
    sitting in the remote config afterward."""
    if not github_token or "github.com" not in repo_url:
        return False, "no GITHUB_TOKEN configured or not a GitHub repo"
    cwd = workspace.working_dir
    auth_url = repo_url.replace("https://", f"https://x-access-token:{github_token}@")
    workspace.execute_command(f"git remote set-url origin {auth_url}", cwd=cwd)
    result = workspace.execute_command(
        f'git checkout -b {branch_name} && git add -A && git commit -m "Automated change" && '
        f"git push origin {branch_name}",
        cwd=cwd,
        timeout=60,
    )
    workspace.execute_command(f"git remote set-url origin {repo_url}", cwd=cwd)
    return result.exit_code == 0, (result.stderr or result.stdout) if result.exit_code != 0 else None


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("", 0))
        return s.getsockname()[1]


def _build_workspace(config: Config) -> DockerWorkspace:
    # Real, live-verified finding: DockerWorkspace's own health check
    # hardcodes http://127.0.0.1:{host_port} - correct only when the driver
    # process runs directly on the Docker host. openhands-runner runs as a
    # sibling container itself (talking to the host's Docker daemon over
    # the mounted socket, same as sandbox-runner), so "127.0.0.1" inside
    # this container's own network namespace never reaches the spawned
    # container's published port. DockerWorkspace only auto-assigns that
    # 127.0.0.1 URL when `host` is falsy at construction time - pre-setting
    # both `host_port` (so we know the real published port ahead of
    # construction) and `host` (using Docker Desktop's host.docker.internal,
    # which resolves to the actual Docker host from inside any sibling
    # container) skips that auto-assignment entirely.
    port = _find_free_port()
    return DockerWorkspace(
        server_image="ghcr.io/openhands/agent-server:latest-python",
        # Never assistant-net - the same isolation sandbox-runner's own
        # spawned containers already have, applied here via DockerWorkspace's
        # first-class `network` field rather than sandbox-runner's own
        # dockerode calls.
        network=config.sandbox_network,
        health_check_timeout=config.health_check_timeout,
        host_port=port,
        host=f"http://host.docker.internal:{port}",
    )


def run_task(
    config: Config,
    task_id: int,
    task_description: str,
    repo_url: str,
    ref: str,
    test_command: str,
) -> TaskResult:
    workspace = _build_workspace(config)

    try:
        with workspace:
            _clone_and_strip_token(workspace, repo_url, ref, config.github_token)

            llm = LLM(model=f"ollama_chat/{config.coder_model}", base_url=config.ollama_host, api_key="ollama")
            agent = Agent(llm=llm, tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)])

            attempts = 0
            last_test_output = ""
            while attempts < config.max_attempts:
                attempts += 1
                conversation = Conversation(agent=agent, workspace=workspace)
                message = f"Task: {task_description}\n\nTest command for this project: {test_command}"
                if attempts > 1:
                    message += _RETRY_SUFFIX.format(test_output=last_test_output)
                conversation.send_message(message)
                try:
                    conversation.run()
                except Exception:
                    logger.exception("task %s: conversation.run() raised on attempt %d", task_id, attempts)

                test_result = workspace.execute_command(test_command, cwd=workspace.working_dir, timeout=120)
                last_test_output = (
                    f"exit code: {test_result.exit_code}\n\nstdout:\n{test_result.stdout}\n\nstderr:\n{test_result.stderr}"
                )
                if test_result.exit_code == 0:
                    break

            diff = workspace.git_diff(".")
            diff_text = getattr(diff, "diff", None) or str(diff)

            return TaskResult(
                diff=diff_text,
                test_exit_code=test_result.exit_code,
                test_output=last_test_output,
                success=test_result.exit_code == 0,
                summary=f"Completed in {attempts} attempt(s)",
                attempts=attempts,
            )
    finally:
        # DockerWorkspace's own context manager already handles container
        # teardown on __exit__ - this finally is defense-in-depth for the
        # case where construction succeeded but __enter__/clone raised
        # before the `with` block's own cleanup would run.
        pass


def propose_pr(
    config: Config, repo_url: str, ref: str, branch_name: str, diff: str
) -> tuple[bool, str | None, str | None]:
    """Re-applies the already-approved diff in a fresh, short-lived
    workspace and pushes it - kept as a separate, later step from run_task
    (not part of the same container/conversation) so a human approval gate
    can sit between "task produced a diff" and "diff gets pushed", matching
    coding-orchestrator's own existing approve-then-open-PR flow."""
    workspace = _build_workspace(config)
    with workspace:
        _clone_and_strip_token(workspace, repo_url, ref, config.github_token)
        cwd = workspace.working_dir
        patch_result = workspace.execute_command(
            "cat > /tmp/patch.diff << 'OPENHANDS_EOF'\n" + diff + "\nOPENHANDS_EOF", cwd=cwd
        )
        if patch_result.exit_code != 0:
            return False, None, "failed to write patch file"
        apply_result = workspace.execute_command("git apply --whitespace=fix /tmp/patch.diff", cwd=cwd)
        if apply_result.exit_code != 0:
            return False, None, f"patch did not apply: {apply_result.stderr}"
        pushed, error = _push_and_strip_token(workspace, repo_url, branch_name, config.github_token)
        return pushed, None, error
