import type { Config } from "./config.js";
import * as db from "./db.js";
import * as sandbox from "./sandbox-client.js";
import * as openhands from "./openhands-client.js";
import { ollamaChat, parseJsonContent } from "./ollama.js";
import { runAgentLoop, truncateToolResult, type AgentTool } from "./agent-loop.js";
import { notifyOrigin } from "./notify.js";
import { TEMPLATE_NAMES, validateTemplate } from "./templates.js";

// Lessons that used to live as hand-written clauses here (CommonJS vs ESM,
// config-file syntax, respecting an existing scaffold) now live in the
// coding_skills table instead - see getActiveCodingSkills/formatSkills
// below - so they're editable without a redeploy and can grow beyond what's
// hardcoded at the moment this file was last touched.
const CODER_SYSTEM_PROMPT =
  "You are the Coder for this task. You have a shell in your own container, with the target " +
  "repository already checked out - use it to look at real files before changing them, make the " +
  "actual code edits (creating, editing, or deleting files as needed), and run the project's test " +
  "command as you go, one command at a time. When you need to write a whole file's exact content " +
  "from scratch or replace it entirely, write it directly rather than building it inside a shell " +
  "command - it's more reliable for content with quotes or special characters. Only make the " +
  "implementation change described in the task and plan; never add test code yourself, a separate " +
  "Tester handles that. When you believe the work is genuinely done, end your final reply with a " +
  "line starting with 'STATUS:' giving a short one-sentence summary of what you just did.";

const TESTER_SYSTEM_PROMPT =
  "You are the Tester for this task, separate from the Coder. The Coder has already made its " +
  "changes in the same container you have shell access to - check what changed, then write test " +
  "coverage for it (new tests, or extending existing ones) by running commands in the container, " +
  "one at a time. When you need to write a whole test file's exact content from scratch or replace " +
  "it entirely, write it directly rather than building it inside a shell command - it's more " +
  "reliable for content with quotes or special characters. When you believe test coverage is " +
  "genuinely adequate, end your final reply with a line starting with 'STATUS:' giving a short " +
  "one-sentence summary of what you just did.";

function formatSkills(skills: db.CodingSkillRow[]): string {
  if (skills.length === 0) return "";
  return "\n\nLessons learned from past tasks:\n" + skills.map((s) => `- ${s.content}`).join("\n");
}

const RETRY_SUFFIX =
  " This is a retry: your previous attempt ended without making any real changes. Try again now, " +
  "actually looking at files and making the edits described.";

interface RetryFeedback {
  source: "coder" | "tester" | "reviewer";
  message: string;
}

interface TaskContext {
  taskId: number;
  task: string;
  // Populated only on the "sandbox" engine path (see runTaskPipeline) -
  // openhands-runner owns its own container for the duration of a single
  // /run-task call, so there's no persistent containerId/workingDir to
  // track here.
  containerId: string;
  workingDir: string;
  // Populated only on the "openhands" engine path - the repo openhands-
  // runner clones itself. Restricted to existing-repo tasks (see
  // runTaskPipeline) since openhands-runner doesn't implement sandbox-
  // runner's from-scratch template-seeding.
  repoUrl: string;
  ref: string;
  testCommand: string;
  // Pre-formatted (formatSkills) - fetched once per task, not per attempt,
  // since active skills don't change mid-task.
  coderSkillsText: string;
  testerSkillsText: string;
  engine: "sandbox" | "openhands";
}

// Matched against write_file's filename to refuse Tester edits to config
// the template already set up correctly. Prompt text alone ("these are a
// known-working scaffold, don't rewrite them") failed to prevent this
// exact mistake twice in a row (the Tester rewrote jest.config.js as raw
// JSON, then repeated the identical broken content 6 times without ever
// adapting) - a deterministic refusal is the reliable version of the same
// guidance, not a replacement for a different lesson.
const CONFIG_FILE_PATTERN =
  /(^|\/)(package(-lock)?\.json|jest\.config\.(js|ts|cjs|mjs|json)|pytest\.ini|babel\.config\.(js|json)|\.babelrc(\.json)?|tsconfig\.json|next\.config\.(js|mjs))$/i;

function agentTools(
  sandboxRunnerUrl: string,
  containerId: string,
  workingDir: string,
  taskId: number,
  options: { denyConfigWrites?: boolean } = {},
): AgentTool[] {
  return [
    {
      name: "run_command",
      description: "Run a shell command in the working directory and return its output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command to run." } },
        required: ["command"],
      },
      execute: async (args) => {
        const result = await sandbox.execInContainer(sandboxRunnerUrl, containerId, {
          command: String(args.command),
          workingDir,
        });
        if (result.exitCode !== 0) {
          // Root-causing "the Coder loops without making progress" needs to
          // see WHY the command it keeps rerunning actually fails - the
          // per-iteration trace (agent-loop.ts) only shows the command
          // name, not its result. Truncated preview, not the full output,
          // to avoid reintroducing the log-bloat problem the terminal-only
          // logging was deliberately scoped to avoid.
          const preview = (result.stderr || result.stdout || "").replace(/\s+/g, " ").slice(0, 400);
          console.log(`task=${taskId} run_command failed (exit ${result.exitCode}): ${preview}`);
        }
        return `exit code: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}\n\nstdout:\n${truncateToolResult(result.stdout)}\n\nstderr:\n${truncateToolResult(result.stderr)}`;
      },
    },
    {
      name: "write_file",
      description:
        "Write a file's exact content, given a filename and the full content. Use this instead of " +
        "a shell command when writing a whole file from scratch or replacing it entirely.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string" },
          content: { type: "string" },
        },
        required: ["filename", "content"],
      },
      execute: async (args) => {
        const filename = String(args.filename);
        const content = String(args.content);
        if (options.denyConfigWrites && CONFIG_FILE_PATTERN.test(filename)) {
          console.log(`task=${taskId} write_file refused (config file, Tester): ${filename}`);
          return (
            `Refused: "${filename}" is project config already set up correctly by the starter scaffold ` +
            `(or by the Coder). You don't need to, and shouldn't, modify it - focus only on test files.`
          );
        }
        await sandbox.writeFileInContainer(sandboxRunnerUrl, containerId, { filename, content, workingDir });
        // Length + first line only - enough to tell "rewrote this file with
        // genuinely different content" from "wrote the identical thing
        // again" (the actual loop signature we're trying to root-cause)
        // without logging full file contents.
        console.log(
          `task=${taskId} write_file: ${filename} (${content.length} bytes, starts "${content.slice(0, 60).replace(/\s+/g, " ")}")`,
        );
        return `Wrote ${filename} successfully.`;
      },
    },
  ];
}

async function callPlanner(
  config: Config,
  task: string,
  isFromScratch: boolean,
): Promise<{ plan: string; testCommand: string; template: string }> {
  const templateGuidance = isFromScratch
    ? "This is a from-scratch task with no existing repository, so also decide which starter template " +
      "(if any) the Coder should begin from - each is a real, pre-built, working scaffold copied into " +
      "the empty project folder before the Coder starts, so it never has to invent test-runner config " +
      "or module-syntax conventions from zero:\n" +
      "- 'node-jest': plain Node.js, CommonJS (require/module.exports), Jest already wired as the test " +
      "command. Pick this for a general JS/Node task with no other signal.\n" +
      "- 'python-pytest': plain Python script/module, pytest already configured.\n" +
      "- 'nextjs-app': a minimal Next.js (App Router) web app, Jest wired for unit tests. Pick this for " +
      "a task that's actually building a web app/frontend/UI.\n" +
      "- 'express-api': a minimal Express backend (app.js exports the app for testing, index.js starts " +
      "it), Jest + supertest wired. Pick this for a task building an HTTP API/backend service.\n" +
      "- 'none': the task needs a language/tooling none of the above cover (e.g. Go, Rust, a shell " +
      "script) - never force one of the above onto a task it doesn't actually fit."
    : "This task targets an existing repository - always return template: 'none'. The existing " +
      "project's own conventions apply; a generic starter template must never override them.";

  const { message } = await ollamaChat(config.ollamaHost, {
    model: config.plannerModel,
    think: true,
    timeoutMs: 240_000,
    messages: [
      {
        role: "system",
        content:
          "You are the Planner for a coding task. Given a task description, dive deep: lay out the " +
          "real architecture of the change (what files/modules are likely involved, what approach to " +
          "take and why, what could go wrong, what needs to be researched or double-checked once the " +
          "Coder can actually look at the repo). You are not writing code yet, only planning - but " +
          "the plan should be concrete enough that a Coder working from it alone, with real shell " +
          "access to the repository, could execute it without having to re-derive the approach from " +
          "scratch. Also decide the exact shell command that should run this project's test suite (a " +
          "Tester will add test coverage using whatever is idiomatic for the task's actual " +
          "language/tooling - e.g. 'node --test' for a plain Node.js project, 'python3 -m pytest' for " +
          "Python, 'go test ./...' for Go, 'cargo test' for Rust). Never default to npm test for a " +
          "non-Node.js task - that fails immediately with no package.json, unrelated to whether the " +
          "code is correct.\n\n" +
          templateGuidance,
      },
      { role: "user", content: `Task: ${task}` },
    ],
    format: {
      type: "object",
      properties: {
        plan: { type: "string" },
        testCommand: { type: "string" },
        template: { type: "string", enum: [...TEMPLATE_NAMES, "none"] },
      },
      required: ["plan", "testCommand"],
    },
  });

  const parsed = parseJsonContent(message.content, { plan: "", testCommand: "", template: "none" });
  return {
    plan: parsed.plan ?? "",
    testCommand: parsed.testCommand ?? "npm test",
    template: validateTemplate(parsed.template),
  };
}

function buildAgentUserPrompt(ctx: TaskContext, plan: string, feedback: RetryFeedback | null): string {
  let prompt = `Task: ${ctx.task}\n\nPlan:\n${plan}\n\nTest command for this project: ${ctx.testCommand}`;
  if (feedback) {
    prompt += `\n\nThis is a retry, in the same container as before - your previous edits are still there. ${feedback.message}`;
  }
  return prompt;
}

// Runs the Coder round, including its own one-shot inline retry if the
// first call comes back empty - replaces "Coder Agent" + "Coder Agent
// Retry" as one real function instead of two n8n agent nodes plus the
// wiring between them.
async function runCoderRound(
  config: Config,
  ctx: TaskContext,
  plan: string,
  feedback: RetryFeedback | null,
): Promise<{ output: string; succeeded: boolean; exhaustedIterations: boolean }> {
  const tools = agentTools(config.sandboxRunnerUrl, ctx.containerId, ctx.workingDir, ctx.taskId);
  const userPrompt = buildAgentUserPrompt(ctx, plan, feedback);
  const systemPrompt = CODER_SYSTEM_PROMPT + ctx.coderSkillsText;

  const first = await runAgentLoop({
    ollamaHost: config.ollamaHost,
    model: config.coderModel,
    systemPrompt,
    userPrompt,
    tools,
    maxIterations: config.coderMaxIterations,
    label: `coder task=${ctx.taskId} attempt=first`,
  });
  if (first.output.trim()) {
    return { output: first.output, succeeded: true, exhaustedIterations: false };
  }

  // Empty output, first attempt - one immediate inline retry with the same
  // "you made no real changes, try again" nudge the old Coder Agent Retry
  // node used, before this counts as a real attempt-level failure.
  const retry = await runAgentLoop({
    ollamaHost: config.ollamaHost,
    model: config.coderModel,
    systemPrompt: systemPrompt + RETRY_SUFFIX,
    userPrompt,
    tools,
    maxIterations: config.coderMaxIterations,
    label: `coder task=${ctx.taskId} attempt=inline-retry`,
  });
  if (!retry.output.trim()) {
    // Both calls came back empty - previously indistinguishable from each
    // other or from a genuine iteration-exhaustion in coding_task_log; log
    // enough here to actually root-cause the next occurrence.
    console.error(
      `coding task ${ctx.taskId}: Coder produced no output on both the first call ` +
        `(${first.exhaustedIterations ? "exhausted iterations" : "empty final reply"}, ` +
        `${first.iterations} iteration(s)) and the inline retry (` +
        `${retry.exhaustedIterations ? "exhausted iterations" : "empty final reply"}, ` +
        `${retry.iterations} iteration(s))`,
    );
  }
  return {
    output: retry.output,
    succeeded: Boolean(retry.output.trim()),
    exhaustedIterations: retry.exhaustedIterations,
  };
}

// Tester round - now checks the SAME "genuinely non-empty output" condition
// the Coder round does (fixes weak point #4: the old Tester Succeeded? only
// checked for the absence of an error, not for empty output), and now
// receives the same retry feedback the Coder gets (fixes weak point #5).
async function runTesterRound(
  config: Config,
  ctx: TaskContext,
  plan: string,
  feedback: RetryFeedback | null,
): Promise<{ output: string; succeeded: boolean }> {
  const tools = agentTools(config.sandboxRunnerUrl, ctx.containerId, ctx.workingDir, ctx.taskId, {
    denyConfigWrites: true,
  });
  const result = await runAgentLoop({
    ollamaHost: config.ollamaHost,
    model: config.testerModel,
    systemPrompt: TESTER_SYSTEM_PROMPT + ctx.testerSkillsText,
    userPrompt: buildAgentUserPrompt(ctx, plan, feedback),
    tools,
    maxIterations: config.testerMaxIterations,
    label: `tester task=${ctx.taskId}`,
  });
  return { output: result.output, succeeded: Boolean(result.output.trim()) };
}

interface ReviewerVerdict {
  verdict: "approve" | "retry" | "give_up";
  reason: string;
  feedbackForCoder: string;
}

// Real, evidenced gap (task #53, a Malayalam-English translation app): the
// Coder's diff literally contained "// Simulate starting the recording
// process (this would be replaced with actual audio recording logic)" and
// three hardcoded fake subtitle strings standing in for the whole feature -
// the Reviewer approved it anyway, judging only "clean, well-commented,
// tests pass" against an unrelated placeholder unit test. Same lesson
// chat-orchestrator/src/safety-net.ts already learned the hard way
// (isConfabulatedAction, hasUnsatisfiedRequiredTool, etc.): prose
// instructions alone aren't a reliable enough judge of genuine completion,
// so a deterministic backstop scans for the actual tell-tale language and
// overrides a false "approve" regardless of what the LLM Reviewer said.
// Scoped to non-test files only - legitimate test mocking (jest.mock, etc.)
// is expected Tester output, not evidence of a faked implementation.
const MOCK_LANGUAGE_MARKERS: RegExp[] = [
  /\bsimulat(e|ed|ing|ion)\b/i,
  /would be replaced with (an? )?(actual|real)/i,
  /in a real (app|implementation|system|scenario|world)/i,
  /\bplaceholder\b/i,
  /\b(dummy|fake) data\b/i,
  /\bnot (yet )?implemented\b/i,
  /\bTODO:?\s*implement\b/i,
  /for (demo|demonstration) purposes/i,
];

const DIFF_TEST_FILE_PATTERN = /\.(test|spec)\.[jt]sx?$|(^|\/)__tests__\//i;

function findMockLanguageMarkers(diff: string): string[] {
  const hits: string[] = [];
  let currentFile = "";
  for (const line of diff.split("\n")) {
    const fileHeader = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileHeader) {
      currentFile = fileHeader[1];
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (DIFF_TEST_FILE_PATTERN.test(currentFile)) continue;
    if (MOCK_LANGUAGE_MARKERS.some((marker) => marker.test(line))) {
      hits.push(line.replace(/^\+/, "").trim().slice(0, 200));
    }
  }
  return hits;
}

async function callReviewer(
  config: Config,
  task: string,
  plan: string,
  diff: string,
  testResult: sandbox.ExecResult,
): Promise<ReviewerVerdict> {
  const { message } = await ollamaChat(config.ollamaHost, {
    model: config.reviewerModel,
    timeoutMs: 240_000,
    messages: [
      {
        role: "system",
        content:
          "You are the Reviewer for a coding task. Given the original task, the plan the Coder was " +
          "given, the diff the Coder actually produced, and the result of running the project's test " +
          "command, judge whether the task is genuinely, correctly done. Approve only if the diff " +
          "actually implements what was asked and the tests genuinely pass (exit code 0, no timeout). " +
          "Explicitly cross-check the diff against the plan: if the plan describes real functionality " +
          "(specific integrations, files, backend logic) that is simply absent from the diff - or " +
          "replaced with a placeholder, a simulated/faked result, or a hardcoded stand-in for what " +
          "should be a real computation or API call - that is not approvable, no matter how clean or " +
          "well-commented what WAS written looks, and no matter whether an unrelated test passes. If " +
          "the tests fail for a reason that looks fixable (a real bug in the diff), verdict 'retry' " +
          "with specific, actionable feedback for the Coder about what's wrong. If the test failure is " +
          "clearly unrelated to the actual code (e.g. a missing test runner for the project's " +
          "language, not the diff itself), say so plainly in your reason rather than blaming the " +
          "implementation. Give up only when further attempts are unlikely to help.",
      },
      {
        role: "user",
        content:
          `Task: ${task}\n\nPlan the Coder was given:\n${plan}\n\nDiff:\n${diff}\n\n` +
          `Test result: exit code ${testResult.exitCode}${testResult.timedOut ? " (timed out)" : ""}\n` +
          `stdout:\n${testResult.stdout}\n\nstderr:\n${testResult.stderr}`,
      },
    ],
    format: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["approve", "retry", "give_up"] },
        reason: { type: "string" },
        feedback_for_coder: { type: "string" },
      },
      required: ["verdict", "reason", "feedback_for_coder"],
    },
  });

  const parsed = parseJsonContent<{ verdict: string; reason: string; feedback_for_coder: string }>(
    message.content,
    { verdict: "give_up", reason: "Reviewer response was not valid JSON", feedback_for_coder: "" },
  );
  const verdict: ReviewerVerdict = {
    verdict: parsed.verdict === "approve" || parsed.verdict === "retry" ? parsed.verdict : "give_up",
    reason: parsed.reason ?? "",
    feedbackForCoder: parsed.feedback_for_coder ?? "",
  };

  if (verdict.verdict === "approve") {
    const mockMarkers = findMockLanguageMarkers(diff);
    if (mockMarkers.length > 0) {
      console.log(`coding task reviewer override: approve -> retry, mock-language markers found: ${JSON.stringify(mockMarkers)}`);
      return {
        verdict: "retry",
        reason:
          `Automated check overrode an LLM 'approve' verdict: the diff contains placeholder/simulated-` +
          `implementation language, which contradicts genuine completion. Flagged line(s): ${mockMarkers.join(" | ")}`,
        feedbackForCoder:
          `Your diff contains placeholder or simulated logic standing in for real functionality (e.g. ` +
          `"${mockMarkers[0]}"). Replace every simulated/mocked/hardcoded piece of core functionality ` +
          `with a real, working implementation - no setTimeout-based fake delays, no hardcoded fake ` +
          `results standing in for a real computation or API call. If a genuinely required external ` +
          `integration (an API key, credentials, a paid service) isn't actually available to you, say ` +
          `so explicitly in your STATUS line instead of faking the result.`,
      };
    }
  }

  return verdict;
}

interface AttemptResult {
  diff: string;
  testResult: sandbox.ExecResult;
  reviewerVerdict: ReviewerVerdict;
}

async function runAttempt(
  config: Config,
  ctx: TaskContext,
  plan: string,
  attemptNumber: number,
  feedback: RetryFeedback | null,
): Promise<AttemptResult | { failed: true; feedback: RetryFeedback }> {
  const coderResult = await runCoderRound(config, ctx, plan, feedback);
  await db.logPhase(
    config,
    ctx.taskId,
    attemptNumber,
    "coder",
    coderResult.succeeded ? "success" : "error",
    coderResult.output,
    coderResult.succeeded
      ? undefined
      : coderResult.exhaustedIterations
        ? "Coder exhausted max iterations without a final reply, even after an inline retry"
        : "Coder returned empty content with zero tool calls, even after an inline retry",
  );
  if (!coderResult.succeeded) {
    return {
      failed: true,
      feedback: {
        source: "coder",
        message:
          "The Coder ran out of iterations or produced no changes last time. Check the current " +
          "state of the repository and continue from there with a different, more targeted approach.",
      },
    };
  }

  const testerResult = await runTesterRound(config, ctx, plan, feedback);
  await db.logPhase(
    config,
    ctx.taskId,
    attemptNumber,
    "tester",
    testerResult.succeeded ? "success" : "error",
    testerResult.output,
    testerResult.succeeded ? undefined : "Tester produced no output",
  );
  if (!testerResult.succeeded) {
    return {
      failed: true,
      feedback: {
        source: "tester",
        message:
          "The Tester ran out of iterations last time before finishing test coverage. Check the " +
          "current state of the test files and continue from there with a different approach.",
      },
    };
  }

  const { diff } = await sandbox.getDiff(config.sandboxRunnerUrl, ctx.containerId, ctx.workingDir);
  const testResult = await sandbox.runTests(config.sandboxRunnerUrl, ctx.containerId, {
    command: ctx.testCommand,
    workingDir: ctx.workingDir,
    timeoutSeconds: 120,
  });
  await db.logPhase(
    config,
    ctx.taskId,
    attemptNumber,
    "test_run",
    "success",
    `exit code: ${testResult.exitCode}\n\nstdout:\n${testResult.stdout}\n\nstderr:\n${testResult.stderr}`,
  );

  const reviewerVerdict = await callReviewer(config, ctx.task, plan, diff, testResult);
  await db.logPhase(config, ctx.taskId, attemptNumber, "reviewer", "success", JSON.stringify(reviewerVerdict));

  return { diff, testResult, reviewerVerdict };
}

// OpenHands engine path (Phase 2, see config.ts's useOpenHandsRunner) -
// replaces runCoderRound + runTesterRound + the manual getDiff/runTests
// calls with a single call to openhands-runner, which owns the actual
// agent loop (clone, edit, test, retry-on-test-failure) itself. Amy still
// owns everything downstream of that: the Reviewer call and finalizeTask's
// approve/retry/give-up policy are unchanged from the sandbox-runner path,
// same "Amy owns policy/orchestration, OpenHands owns the coding loop"
// split the architecture was designed around.
//
// Known limitation, not yet addressed: unlike the sandbox-runner path
// (one container persists across every attempt for this task, so a
// Reviewer-triggered retry continues from the previous attempt's edits),
// openhands-runner clones fresh on every call - a Reviewer 'retry' verdict
// here restarts from a clean checkout, losing the prior attempt's edits.
// This doesn't affect openhands-runner's own internal test-driven retries
// (which do persist state within a single call), only the rarer case
// where tests pass but the Reviewer still judges the implementation wrong.
async function runAttemptViaOpenHands(
  config: Config,
  ctx: TaskContext,
  plan: string,
  attemptNumber: number,
  feedback: RetryFeedback | null,
): Promise<AttemptResult | { failed: true; feedback: RetryFeedback }> {
  const taskDescription = buildAgentUserPrompt(ctx, plan, feedback);

  let result: openhands.RunTaskResult;
  try {
    result = await openhands.runTask(config.openhandsRunnerUrl, {
      taskId: ctx.taskId,
      taskDescription,
      repoUrl: ctx.repoUrl,
      ref: ctx.ref,
      testCommand: ctx.testCommand,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.logPhase(config, ctx.taskId, attemptNumber, "openhands_agent", "error", "", message);
    return {
      failed: true,
      feedback: {
        source: "coder",
        message:
          `openhands-runner failed to complete: ${message}. Check the current state of the repository ` +
          "and continue from there with a different, more targeted approach.",
      },
    };
  }

  await db.logPhase(
    config,
    ctx.taskId,
    attemptNumber,
    "openhands_agent",
    "success",
    `${result.summary} (${result.attempts} internal attempt(s))`,
  );

  // Reviewer/finalizeTask both expect sandbox.ExecResult's shape -
  // openhands-runner's test output isn't split into separate stdout/stderr
  // streams (task_runner.py's own last_test_output is already combined),
  // so stderr stays empty rather than duplicating the combined text into
  // both fields.
  const testResult: sandbox.ExecResult = {
    exitCode: result.testExitCode,
    stdout: result.testOutput,
    stderr: "",
    timedOut: false,
    durationMs: 0,
  };
  await db.logPhase(
    config,
    ctx.taskId,
    attemptNumber,
    "test_run",
    "success",
    `exit code: ${testResult.exitCode}\n\n${testResult.stdout}`,
  );

  const reviewerVerdict = await callReviewer(config, ctx.task, plan, result.diff, testResult);
  await db.logPhase(config, ctx.taskId, attemptNumber, "reviewer", "success", JSON.stringify(reviewerVerdict));

  return { diff: result.diff, testResult, reviewerVerdict };
}

async function finalizeTask(
  config: Config,
  ctx: TaskContext,
  attemptNumber: number,
  result: AttemptResult | { failed: true; feedback: RetryFeedback },
): Promise<void> {
  if ("failed" in result) {
    await db.updateTask(config, ctx.taskId, {
      status: "needs_review_failed",
      latest_status: "Needs human review",
      attempt_count: attemptNumber,
      reviewer_verdict: "give_up",
      reviewer_reason: result.feedback.message,
    });
    return;
  }

  const approved = result.reviewerVerdict.verdict === "approve" && result.testResult.exitCode === 0;

  await db.updateTask(config, ctx.taskId, {
    status: approved ? "proposed" : "needs_review_failed",
    latest_status: approved ? "Done" : "Needs human review",
    attempt_count: attemptNumber,
    diff: result.diff,
    test_output: `exit code: ${result.testResult.exitCode}\n\nstdout:\n${result.testResult.stdout}\n\nstderr:\n${result.testResult.stderr}`,
    reviewer_verdict: result.reviewerVerdict.verdict,
    reviewer_reason: result.reviewerVerdict.reason,
  });

  if (!approved) return;

  const row = await db.getTask(config, ctx.taskId);
  if (!row.target_repo_url || !row.target_repo_url.includes("github.com")) return;

  const branchName = `coding-agent/${row.project_folder}`;
  // openhands-runner's /propose-pr re-clones and re-applies the diff itself
  // (see openhands-runner/src/task_runner.py's propose_pr) rather than
  // pushing from a container sandbox-runner already has open - same
  // token-isolation guarantee (GITHUB_TOKEN embedded in the remote URL for
  // exactly one push, then stripped), different transport.
  const prResult =
    ctx.engine === "openhands"
      ? await openhands.proposePr(config.openhandsRunnerUrl, {
          repoUrl: row.target_repo_url,
          ref: row.target_ref,
          branchName,
          diff: result.diff,
          prTitle: row.task_description.slice(0, 72),
          prBody: result.reviewerVerdict.reason,
        })
      : await sandbox.proposePr(config.sandboxRunnerUrl, {
          repoUrl: row.target_repo_url,
          baseRef: row.target_ref,
          patch: result.diff,
          branchName,
          commitMessage: row.task_description.slice(0, 72),
          prTitle: row.task_description.slice(0, 72),
          prBody: result.reviewerVerdict.reason,
        });
  if (prResult.pushed && prResult.prUrl) {
    await db.updateTask(config, ctx.taskId, { pr_url: prResult.prUrl });
  } else {
    // Found via real usage: a bad/expired GITHUB_TOKEN makes this fail on
    // every task, but the DB-visible state (latest_status: "Done", empty
    // pr_url) was indistinguishable from a task still being worked on -
    // console.error alone isn't visible to code_task_status or anyone
    // just reading the DB, and container log history doesn't survive a
    // restart, so a real failure like this can go unnoticed indefinitely.
    console.error(
      `coding task ${ctx.taskId}: approved but PR was not opened - pushed=${prResult.pushed}, ` +
        `prUrl=${prResult.prUrl ?? "(none)"}, error=${prResult.error ?? "(none)"}`,
    );
    await db.updateTask(config, ctx.taskId, {
      latest_status: `Approved, but PR was not opened: ${prResult.error ?? "unknown error"}`,
    });
  }
}

// The state machine. Replaces the 54-node graph's Coder/Tester/Reviewer/
// retry section: a single real loop (fixes weak point #9's triplicated
// retry branches), guaranteed cleanup and notify via try/finally (fixes
// weak point #6), and a thrown exception anywhere here is caught by one
// real catch block (fixes weak point #1/#7 - no per-node onError to
// individually remember, no pairedItem lineage to break).
export async function runTaskPipeline(config: Config, taskId: number): Promise<void> {
  const task = await db.getTask(config, taskId);
  let containerId: string | undefined;

  try {
    // Planner runs before container creation now (it only ever needed the
    // task description, never repo access) so its from-scratch template
    // choice can actually be passed to the container-creation call below,
    // instead of the container already existing by the time a template
    // decision would be known.
    const isFromScratch = !task.target_repo_url;
    const { plan, testCommand, template } = await callPlanner(config, task.task_description, isFromScratch);
    await db.logPhase(config, taskId, null, "plan", "success", plan);

    // Phase 2 (see config.ts's useOpenHandsRunner) - only existing-repo
    // tasks can use the openhands-runner engine. openhands-runner has no
    // notion of sandbox-runner's from-scratch template-seeding, and a
    // from-scratch task has no repoUrl for it to clone in the first place,
    // so that path always falls back to the sandbox-runner engine below
    // regardless of the flag.
    const useOpenHands = config.useOpenHandsRunner && !isFromScratch;

    let ctx: TaskContext;
    if (useOpenHands) {
      // No sandbox-runner container to create here - openhands-runner owns
      // its own container for the duration of each /run-task call (see
      // runAttemptViaOpenHands below). containerId is left undefined, so
      // the cleanup in `finally` naturally skips sandbox.destroyContainer.
      await db.updateTask(config, taskId, { latest_status: "Planning the approach" });
      const [coderSkills, testerSkills] = await Promise.all([
        db.getActiveCodingSkills(config, "coder", null),
        db.getActiveCodingSkills(config, "tester", null),
      ]);
      ctx = {
        taskId,
        task: task.task_description,
        containerId: "",
        workingDir: "",
        repoUrl: task.target_repo_url as string,
        ref: task.target_ref,
        testCommand: task.test_command || testCommand,
        coderSkillsText: formatSkills(coderSkills),
        testerSkillsText: formatSkills(testerSkills),
        engine: "openhands",
      };
    } else {
      // sandbox-runner's own /task route requires `repoUrl` unconditionally
      // (it has no notion of "from scratch, use the fallback as primary") -
      // so for a from-scratch task (no target_repo_url), the fallback repo
      // must be sent AS repoUrl directly, with no separate fallback fields
      // at all. Mirrors exactly the ternary the old n8n "Create Task
      // Container" node used. `template` is only ever passed on this
      // from-scratch branch - an existing repo's own conventions are never
      // overridden, even if the Planner somehow still returned one.
      const container = task.target_repo_url
        ? await sandbox.createContainer(config.sandboxRunnerUrl, {
            repoUrl: task.target_repo_url,
            ref: task.target_ref,
            projectFolder: "",
            taskId: String(taskId),
            fallbackRepoUrl: task.fallback_repo_url || undefined,
            fallbackRef: "main",
            fallbackProjectFolder: task.project_folder,
          })
        : await sandbox.createContainer(config.sandboxRunnerUrl, {
            repoUrl: task.fallback_repo_url || undefined,
            ref: "main",
            projectFolder: task.project_folder,
            taskId: String(taskId),
            template: template === "none" ? undefined : template,
          });
      containerId = container.containerId;
      await db.updateTask(config, taskId, {
        container_id: container.containerId,
        target_repo_url: container.actualRepoUrl,
        project_folder: container.actualProjectFolder,
        latest_status: "Planning the approach",
      });

      // Fetched once per task, not per attempt/round - active skills don't
      // change mid-task, and this avoids a DB round-trip on every retry.
      const skillsTemplate = template === "none" ? null : template;
      const [coderSkills, testerSkills] = await Promise.all([
        db.getActiveCodingSkills(config, "coder", skillsTemplate),
        db.getActiveCodingSkills(config, "tester", skillsTemplate),
      ]);

      ctx = {
        taskId,
        task: task.task_description,
        containerId: container.containerId,
        workingDir: container.workingDir,
        repoUrl: "",
        ref: "",
        testCommand: task.test_command || testCommand,
        coderSkillsText: formatSkills(coderSkills),
        testerSkillsText: formatSkills(testerSkills),
        engine: "sandbox",
      };
    }

    try {
      let feedback: RetryFeedback | null = null;
      let result: AttemptResult | { failed: true; feedback: RetryFeedback } | undefined;
      let attempt = 1;

      for (; attempt <= config.maxAttempts; attempt++) {
        await db.updateTask(config, taskId, { latest_status: `Attempt ${attempt}: coding in progress`, attempt_count: attempt });
        result = useOpenHands
          ? await runAttemptViaOpenHands(config, ctx, plan, attempt, feedback)
          : await runAttempt(config, ctx, plan, attempt, feedback);

        if ("failed" in result) {
          if (attempt === config.maxAttempts) break;
          feedback = result.feedback;
          continue;
        }
        if (result.reviewerVerdict.verdict === "approve") break;
        if (result.reviewerVerdict.verdict !== "retry" || attempt === config.maxAttempts) break;
        feedback = {
          source: "reviewer",
          message:
            `The Reviewer rejected the last attempt because: ${result.reviewerVerdict.reason}\n\n` +
            `Specific feedback: ${result.reviewerVerdict.feedbackForCoder}\n\nFix this issue. Do not redo work that was already correct.`,
        };
      }

      if (result) {
        await finalizeTask(config, ctx, attempt, result);
      }
    } catch (e) {
      if (e instanceof sandbox.CommandLimitExceededError) {
        // A distinguishable, expected outcome (weak point #2) rather than a
        // generic crash - the retry mechanism can legitimately use up the
        // sandbox's per-container command budget across several attempts.
        await db.updateTask(config, taskId, {
          status: "resource_limit_reached",
          latest_status: "Stopped: hit the sandbox's command limit",
        });
        await db.logPhase(config, taskId, null, "error", "error", "", e.message);
      } else {
        throw e;
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`coding task ${taskId} failed:`, e);
    await db.updateTask(config, taskId, { status: "needs_review_failed", latest_status: `Failed: ${message}` });
    await db.logPhase(config, taskId, null, "error", "error", "", message);
  } finally {
    if (containerId) {
      // ALWAYS runs, no matter which path above returned or threw - fixes
      // weak point #6, where give-up paths used to skip this entirely.
      await sandbox.destroyContainer(config.sandboxRunnerUrl, containerId).catch((e) => {
        console.error(`coding task ${taskId}: failed to destroy container ${containerId}:`, e);
      });
    }
    const finalRow = await db.getTask(config, taskId);
    await notifyOrigin(config, finalRow);
  }
}
