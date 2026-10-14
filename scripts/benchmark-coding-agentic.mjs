#!/usr/bin/env node
// Execution-verified, multi-turn agentic coding benchmark - a harder
// complement to benchmark-models.mjs's single-shot coding-tool tests
// (scripts/benchmark-results/2026-10-14T06-07-47-074Z.json), which showed
// qwen3.5:9b and qwen3:14b tied exactly (100%/100%) on easy, regex-graded
// one-liners. That tie could be a ceiling effect - both models solving
// everything asked, while diverging only on harder problems. This runs a
// real agent loop (write_file/run_command, exactly coding-orchestrator's
// own schema) against genuinely harder tasks, in a disposable temp
// directory, and grades by actually re-running the verification command
// ourselves afterward - never trusting the model's own self-report of
// success.
//
// Usage:
//   node scripts/benchmark-coding-agentic.mjs
//   node scripts/benchmark-coding-agentic.mjs --models=qwen3.5:9b,qwen3:14b --reps=2

import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

const rawArgs = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);
const models = rawArgs.models ? rawArgs.models.split(",") : ["qwen3.5:9b", "qwen3:14b"];
const reps = Number(rawArgs.reps || 2);
const MAX_ITERATIONS = 6;
const COMMAND_TIMEOUT_MS = 10_000;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the working directory and return its output.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command to run." } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a file's exact content, given a filename and the full content. Use this instead of " +
        "a shell command when writing a whole file from scratch or replacing it entirely.",
      parameters: {
        type: "object",
        properties: { filename: { type: "string" }, content: { type: "string" } },
        required: ["filename", "content"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tasks - each defines an optional seed file (pre-existing buggy code, to
// test fix-in-place rather than write-from-scratch), a prompt, and an
// independent verification run by the harness itself after the agent loop
// ends, never by trusting the model's own claim.
// ---------------------------------------------------------------------------
const TASKS = [
  {
    name: "fib-build-and-verify",
    seedFiles: {},
    prompt:
      "Create a file called fib.py implementing a function fib(n) that returns the nth Fibonacci " +
      "number, 0-indexed (fib(0)=0, fib(1)=1, fib(2)=1, fib(3)=2, ...). Then verify your " +
      "implementation is correct by actually running it and checking the output - fib(10) should " +
      "equal 55. If your first attempt has a bug, fix it and re-verify before finishing.",
    verify: { command: "python3", args: ["-c", "from fib import fib; print(fib(10))"], expect: "55" },
  },
  {
    name: "fix-reverse-words-bug",
    seedFiles: {
      "reverse_words.py": "def reverse_words(s):\n    return s.split(' ').reverse()\n",
    },
    prompt:
      "There's a file called reverse_words.py in the current directory with a function " +
      "reverse_words(s) meant to reverse the order of words in a sentence (e.g. 'hello world' -> " +
      "'world hello'), but it has a bug. Find and fix the bug, then verify your fix by actually " +
      "running a command that checks reverse_words('the quick brown fox') returns " +
      "'fox brown quick the'.",
    verify: {
      command: "python3",
      args: ["-c", "from reverse_words import reverse_words; print(reverse_words('the quick brown fox'))"],
      expect: "fox brown quick the",
    },
  },
];

// ---------------------------------------------------------------------------
// Ollama non-streaming chat client (multi-turn, so simplicity over TTFT here)
// ---------------------------------------------------------------------------
async function chatOnce(model, messages) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools: TOOLS,
      think: false,
      stream: false,
      options: { temperature: 0, num_predict: 600 },
    }),
  });
  if (!res.ok) throw new Error(`${model}: request failed ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.message;
}

function parseArgs(toolCall) {
  const raw = toolCall.function?.arguments;
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function runCommandInDir(dir, command) {
  try {
    const { stdout, stderr } = await execFileAsync("sh", ["-c", command], {
      cwd: dir,
      timeout: COMMAND_TIMEOUT_MS,
    });
    return `exit code: 0\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}`;
  } catch (err) {
    return `exit code: ${err.code ?? 1}${err.killed ? " (timed out)" : ""}\n\nstdout:\n${err.stdout ?? ""}\n\nstderr:\n${err.stderr ?? err.message}`;
  }
}

async function runTask(model, task) {
  const dir = mkdtempSync(join(tmpdir(), "agentic-bench-"));
  for (const [filename, content] of Object.entries(task.seedFiles)) {
    writeFileSync(join(dir, filename), content);
  }

  const messages = [{ role: "user", content: task.prompt }];
  const toolLog = [];
  let iterations = 0;
  let finalText = "";

  try {
    for (; iterations < MAX_ITERATIONS; iterations++) {
      const message = await chatOnce(model, messages);
      messages.push(message);
      if (!message.tool_calls?.length) {
        finalText = message.content || "";
        break;
      }
      for (const call of message.tool_calls) {
        const args = parseArgs(call);
        let result;
        if (call.function.name === "write_file") {
          writeFileSync(join(dir, String(args.filename)), String(args.content ?? ""));
          result = `Wrote ${args.filename} successfully.`;
          toolLog.push(`write_file(${args.filename}, ${(args.content ?? "").length} bytes)`);
        } else if (call.function.name === "run_command") {
          result = await runCommandInDir(dir, String(args.command));
          toolLog.push(`run_command(${args.command})`);
        } else {
          result = `Unknown tool ${call.function.name}`;
        }
        messages.push({ role: "tool", content: result });
      }
    }

    // Independent verification - re-run ourselves, ignore what the model claimed.
    const verifyCmd = `${task.verify.command} ${task.verify.args.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ")}`;
    const verifyResult = await runCommandInDir(dir, verifyCmd);
    const stdoutMatch = verifyResult.match(/stdout:\n([\s\S]*?)\n\nstderr:/);
    const actualOutput = (stdoutMatch?.[1] ?? "").trim();
    const pass = actualOutput === task.verify.expect;

    return { task: task.name, pass, iterations, toolLog, finalText: finalText.slice(0, 200), actualOutput, hitMaxIterations: iterations >= MAX_ITERATIONS };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const allResults = [];
for (const model of models) {
  console.error(`\n=== ${model} ===`);
  // Warmup
  await chatOnce(model, [{ role: "user", content: "hi" }]);
  for (const task of TASKS) {
    const runs = [];
    for (let i = 0; i < reps; i++) {
      const start = performance.now();
      const r = await runTask(model, task);
      const ms = performance.now() - start;
      console.error(
        `  [${task.name}] rep ${i + 1}: ${r.pass ? "PASS" : "FAIL"} - ${r.iterations} iterations, ` +
          `actual="${r.actualOutput}" expected="${task.verify.expect}" (${ms.toFixed(0)}ms)${r.hitMaxIterations ? " [HIT MAX ITERATIONS]" : ""}`
      );
      runs.push({ ...r, ms });
    }
    allResults.push({ model, task: task.name, runs });
  }
}

console.log("\n=== Summary ===");
const cols = ["model", "task", "passRate", "avgIterations", "avgMs"];
const summaries = allResults.map((r) => ({
  model: r.model,
  task: r.task,
  passRate: `${r.runs.filter((x) => x.pass).length}/${r.runs.length}`,
  avgIterations: (r.runs.reduce((a, x) => a + x.iterations, 0) / r.runs.length).toFixed(1),
  avgMs: (r.runs.reduce((a, x) => a + x.ms, 0) / r.runs.length).toFixed(0),
}));
const widths = cols.map((c) => Math.max(c.length, ...summaries.map((s) => String(s[c]).length)) + 2);
const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join("");
console.log(line(cols));
console.log(widths.map((w) => "-".repeat(w - 1)).join(" "));
for (const s of summaries) console.log(line(cols.map((c) => s[c])));

const resultsDir = join(__dirname, "benchmark-results");
mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = join(resultsDir, `agentic-coding-${stamp}.json`);
writeFileSync(jsonPath, JSON.stringify({ config: { models, reps }, results: allResults, summaries }, null, 2));
console.log(`\nWrote ${jsonPath}`);
