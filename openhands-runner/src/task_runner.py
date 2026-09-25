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
import re
import socket
import uuid
from dataclasses import dataclass

import httpx
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


# Directories the agent-server image/process itself puts inside the
# workspace, unrelated to whatever repository gets checked out there -
# bash_events (one JSON file per executed command, full command text
# included) and conversations are created at container startup;
# project is a pre-built scaffold baked into the ghcr.io/openhands/
# agent-server image itself (confirmed live via its fixed, image-build-time
# mtime, unchanged across fresh containers). Their presence is also *why*
# `git clone <url> .` doesn't work here - see _clone_and_strip_token's
# docstring - not just a diff-cleanliness concern. Excluded from every
# diff/add below, and _scrub_internal_state additionally deletes
# bash_events/conversations from disk before the agent's own shell ever
# gets a chance to read the (secret-bearing) former (see that function's
# docstring for why deletion, not just diff exclusion, is required).
_AGENT_SERVER_INTERNAL_DIRS = ("bash_events", "conversations", "project")
# Single-quoted - unquoted parens in `:(exclude)...` are shell metacharacters
# (subshell syntax). Sent as-is through execute_command's shell, `(exclude)`
# gets parsed as a subshell invocation and the whole git command silently
# fails before git ever runs, producing empty stdout - live-verified this
# session as a real bug (a clean git repo state was reported as an empty
# diff, not an error, since neither call site checks these commands' exit
# codes - see git_diff below for why they now do).
_DIFF_PATHSPEC = ["."] + [f"':(exclude){d}'" for d in _AGENT_SERVER_INTERNAL_DIRS]


def _clone_and_strip_token(workspace: DockerWorkspace, repo_url: str, ref: str, github_token: str | None) -> None:
    """Checks out repo_url@ref into the workspace with the token embedded
    in the remote URL for exactly the fetch command, then immediately
    rewrites the remote to the plain URL - the agent's own conversation
    starts only after this returns, so its shell access never sees a
    token-bearing remote. Mirrors sandbox-runner's own documented
    GITHUB_TOKEN isolation, just at a different layer (this module's
    driver code operating the workspace directly, bypassing the agent,
    instead of a separate ephemeral push-only container).

    Real, live-verified finding (2026-09-24): `git clone <url> .` - this
    function's original approach - only works into an *empty* directory,
    but ghcr.io/openhands/agent-server's own workspace is never actually
    empty (bash_events/conversations get created at container startup, and
    `project` is a scaffold baked into the image itself) - every clone
    attempt failed with "destination path '.' already exists and is not an
    empty directory", silently leaving no repository at all in place (the
    agent would then create the requested file directly against the empty
    scaffold and still "succeed," making this invisible until propose_pr's
    later git commands failed with "not a git repository"). `git init` +
    `git fetch` + `git checkout FETCH_HEAD` has no such requirement - it
    works the same whether the directory is empty or already has unrelated
    files sitting in it.

    The stripped-remote guarantee alone also turned out to be incomplete:
    see _scrub_internal_state, called right after this returns, for a
    second, real leak this session found in the same code path.
    """
    cwd = workspace.working_dir
    url = repo_url.replace("https://", f"https://x-access-token:{github_token}@") if github_token else repo_url
    workspace.execute_command("git init .", cwd=cwd, timeout=30)
    workspace.execute_command(f"git remote add origin {url}", cwd=cwd, timeout=30)
    result = workspace.execute_command(f"git fetch --depth 1 origin {ref}", cwd=cwd, timeout=120)
    if result.exit_code == 0:
        workspace.execute_command("git checkout FETCH_HEAD", cwd=cwd, timeout=30)
    else:
        # `ref` might not be directly fetchable (e.g. a commit SHA on a
        # server that restricts uploadpack.allowReachableSHA1InWant) - fall
        # back to a full fetch, which makes every ref/SHA on the remote
        # available locally regardless. FETCH_HEAD isn't reliable here (an
        # unqualified `git fetch origin` can fetch multiple refs at once),
        # so check out `ref` itself instead.
        workspace.execute_command("git fetch origin", cwd=cwd, timeout=120)
        workspace.execute_command(f"git checkout {ref}", cwd=cwd, timeout=30)
    if github_token:
        workspace.execute_command(f"git remote set-url origin {repo_url}", cwd=cwd)


def _scrub_internal_state(workspace: DockerWorkspace) -> None:
    """Real, live-verified finding (2026-09-24): the agent-server persists
    the full text of every command it runs to workspace/bash_events/*.json
    (its own internal event log - unrelated to, and not covered by, the
    SDK's own driver-side log redaction in openhands.sdk.utils.command,
    which only sees this module's own subprocess calls, never anything the
    agent-server logs about commands it executed on its own REST API).

    _clone_and_strip_token's embedded-token clone command got written there
    verbatim, including the real GITHUB_TOKEN - which then got swept into a
    git diff (via git add -A), landed in Postgres, was shown to the
    Reviewer LLM, and nearly got pushed into an actual PR before a separate
    bug (see run_task's git-diff extraction) caused the push itself to
    fail.

    Excluding bash_events from the diff (see _DIFF_PATHSPEC) stops it from
    reaching Postgres/the Reviewer/a PR, but doesn't stop the agent's own
    TerminalTool from reading the file directly off disk once its
    conversation starts (forwarding GITHUB_TOKEN as a container env var so
    the clone command could reference it as a shell variable instead was
    considered and rejected - openhands.sdk.utils.command.sanitized_env
    deliberately strips comparable secrets from the env FOR THIS EXACT
    REASON, "to prevent LLM-driven agents from accessing credentials via
    terminal commands", and a container-wide env var would be strictly
    worse than the current leak: persistently agent-visible for the whole
    task instead of transiently on disk before the agent starts). Deleting
    the file is the only complete fix - called right after clone-and-strip,
    before the agent's own conversation begins.
    """
    cwd = workspace.working_dir
    for internal_dir in _AGENT_SERVER_INTERNAL_DIRS:
        workspace.execute_command(f"rm -rf {internal_dir}", cwd=cwd)


def _push_and_strip_token(
    workspace: DockerWorkspace,
    repo_url: str,
    branch_name: str,
    github_token: str | None,
    git_author_name: str,
    git_author_email: str,
) -> tuple[bool, str | None]:
    """Same token-isolation pattern as clone - push happens driver-side,
    outside the agent's own tool-call history, and the token is never left
    sitting in the remote config afterward.

    Real, live-verified finding (2026-09-24), more serious than the
    equivalent leak in run_task's diff: the `git remote set-url origin
    <auth_url>` call just below writes the real token into bash_events
    (same mechanism as _clone_and_strip_token's docstring describes) - and
    unlike run_task, where that only risked polluting a diff shown to the
    Reviewer, here it sits on disk immediately before `git add -A`, which
    would otherwise commit it directly into the pushed commit itself. The
    scrub below runs between the set-url and the add/commit - not after,
    like _clone_and_strip_token's - specifically to close that window
    before `git add -A` can ever see it. The pathspec exclusion on `git
    add` is defense-in-depth on top of that, not the primary guarantee.
    """
    if not github_token or "github.com" not in repo_url:
        return False, "no GITHUB_TOKEN configured or not a GitHub repo"
    cwd = workspace.working_dir
    auth_url = repo_url.replace("https://", f"https://x-access-token:{github_token}@")
    workspace.execute_command(f"git remote set-url origin {auth_url}", cwd=cwd)
    _scrub_internal_state(workspace)
    workspace.execute_command(f'git config user.name "{git_author_name}"', cwd=cwd)
    workspace.execute_command(f'git config user.email "{git_author_email}"', cwd=cwd)
    pathspec = " ".join(_DIFF_PATHSPEC)
    result = workspace.execute_command(
        f'git checkout -b {branch_name} && git add -A -- {pathspec} && git commit -m "Automated change" && '
        f"git push origin {branch_name}",
        cwd=cwd,
        timeout=60,
    )
    workspace.execute_command(f"git remote set-url origin {repo_url}", cwd=cwd)
    _scrub_internal_state(workspace)
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
            # Must run before the Agent/Conversation below - see
            # _scrub_internal_state's docstring for why this is a real
            # security fix, not just hygiene, on this specific code path.
            _scrub_internal_state(workspace)

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

            # Real, live-verified finding: BaseWorkspace.git_diff() is
            # per-file (before/after content of one path, returned as a
            # GitDiff{modified, original} pair) - it has nothing to do with
            # a repo-wide unified diff despite the name. Passing "." as the
            # path silently produced GitDiff's own str() repr instead of a
            # real patch (a diff that "looked plausible enough" for the
            # Reviewer LLM to approve, but that git apply correctly
            # rejected as "No valid patches in input" once propose_pr tried
            # to actually use it). Fixed by shelling out for a real diff via
            # `git add -A -N && git diff` - the exact same command
            # sandbox-runner's own diffTaskContainer already uses, and for
            # the same reason: `-N` (intent-to-add) is what makes brand-new
            # files show up in `git diff` at all, since plain `git diff`
            # only ever shows changes to files git already knows about.
            # Excludes bash_events/conversations (see _AGENT_SERVER_INTERNAL_
            # DIRS/_DIFF_PATHSPEC) - _scrub_internal_state already deleted
            # bash_events once, above, but the agent's own tool calls and
            # the test-command run just above both create fresh entries
            # during the run itself, none of which belong in the task's
            # actual code diff.
            cwd = workspace.working_dir
            pathspec = " ".join(_DIFF_PATHSPEC)
            add_result = workspace.execute_command(f"git add -A -N -- {pathspec}", cwd=cwd)
            diff_result = workspace.execute_command(f"git -c color.ui=false diff -- {pathspec}", cwd=cwd, timeout=60)
            if add_result.exit_code != 0 or diff_result.exit_code != 0:
                # Checked explicitly, not left to silently fall through as
                # an empty diff - live-verified this session as a real bug
                # (a shell-syntax mistake in _DIFF_PATHSPEC made both
                # commands fail outright, and the resulting empty string
                # was indistinguishable from "no changes made" until the
                # Reviewer approved an empty diff and the PR push failed
                # with a confusing, once-removed "No valid patches" error).
                logger.error(
                    "task %s: git diff extraction failed - add exit %d (%s), diff exit %d (%s)",
                    task_id,
                    add_result.exit_code,
                    add_result.stderr,
                    diff_result.exit_code,
                    diff_result.stderr,
                )
            diff_text = diff_result.stdout

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


def _parse_github_owner_repo(repo_url: str) -> tuple[str, str] | None:
    match = re.search(r"github\.com[/:]([^/]+)/([^/.]+?)(\.git)?/?$", repo_url)
    return (match.group(1), match.group(2)) if match else None


def _create_pull_request(
    config: Config, repo_url: str, branch_name: str, base_ref: str, pr_title: str, pr_body: str
) -> tuple[str | None, str | None]:
    """Real, live-verified finding (2026-09-24): this function didn't exist
    at all until now - propose_pr only ever pushed the branch and returned
    prUrl=None unconditionally, leaving coding-orchestrator's finalizeTask
    (which requires both `pushed` AND `prUrl` before recording the task as
    genuinely done - see pipeline.ts) permanently stuck reporting "Approved,
    but PR was not opened: unknown error" even on a fully successful push.
    Mirrors sandbox-runner's own proposePullRequest (executor.ts) exactly:
    a plain POST to GitHub's REST API using the same token, called only
    after the push itself has already succeeded.
    """
    owner_repo = _parse_github_owner_repo(repo_url)
    if not owner_repo or not config.github_token:
        return None, "could not determine owner/repo from repoUrl, or no GITHUB_TOKEN configured"
    owner, repo = owner_repo
    try:
        response = httpx.post(
            f"https://api.github.com/repos/{owner}/{repo}/pulls",
            headers={
                "Authorization": f"Bearer {config.github_token}",
                "Accept": "application/vnd.github+json",
            },
            json={"title": pr_title, "head": branch_name, "base": base_ref, "body": pr_body},
            timeout=30.0,
        )
    except httpx.HTTPError as e:
        return None, f"PR creation request failed: {e}"
    if response.status_code >= 300:
        return None, f"PR creation failed: {response.status_code} {response.text}"
    return response.json().get("html_url"), None


def propose_pr(
    config: Config, repo_url: str, ref: str, branch_name: str, diff: str, pr_title: str, pr_body: str
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
        pushed, push_error = _push_and_strip_token(
            workspace, repo_url, branch_name, config.github_token, config.git_author_name, config.git_author_email
        )
        if not pushed:
            return False, None, push_error
        pr_url, pr_error = _create_pull_request(config, repo_url, branch_name, ref, pr_title, pr_body)
        if pr_error:
            return True, None, f"branch pushed, but PR creation failed: {pr_error}"
        return True, pr_url, None
