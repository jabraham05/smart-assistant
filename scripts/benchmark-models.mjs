#!/usr/bin/env node
// Benchmarks local Ollama models on tool-calling accuracy, general accuracy, and latency.
// Talks directly to the Ollama HTTP API (bypasses n8n) so results reflect the model alone.
//
// Usage:
//   node scripts/benchmark-models.mjs
//   node scripts/benchmark-models.mjs --models=llama3.1:8b,qwen3:8b --reps=3
//   node scripts/benchmark-models.mjs --think   # let hybrid-reasoning models (qwen3) think before answering
//
// Writes a full JSON + Markdown report under scripts/benchmark-results/.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

const rawArgs = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  })
);

const DEFAULT_MODELS = [
  "llama3.2:3b",
  "llama3.1:8b",
  "llama3-groq-tool-use:8b",
  "qwen3:4b",
  "qwen3:8b",
  "qwen3:14b",
];

const models = rawArgs.models ? rawArgs.models.split(",") : DEFAULT_MODELS;
const reps = Number(rawArgs.reps || 3);
const think = rawArgs.think === "true";

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI-style function schema; Ollama's native tool format)
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a location",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City name" },
          unit: { type: "string", enum: ["celsius", "fahrenheit"] },
        },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Evaluate a math expression and return the numeric result",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the web for current information not in the model's training data",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "Create a reminder for the user",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          time: { type: "string", description: "When to remind, e.g. 'tomorrow at 5pm'" },
        },
        required: ["text", "time"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------
const TOOL_TESTS = [
  {
    name: "weather-basic",
    prompt: "What's the weather like in Tokyo right now?",
    expectedTool: "get_weather",
    checkArgs: (a) => /tokyo/i.test(a.location || ""),
  },
  {
    name: "weather-with-unit",
    prompt: "What's the weather in Berlin? Give it to me in Fahrenheit.",
    expectedTool: "get_weather",
    checkArgs: (a) => /berlin/i.test(a.location || "") && /fahrenheit|\bf\b/i.test(String(a.unit || "")),
  },
  {
    name: "calculate",
    prompt: "Use your tools to calculate 47 times 89.",
    expectedTool: "calculate",
    checkArgs: (a) => /47/.test(a.expression || "") && /89/.test(a.expression || ""),
  },
  {
    name: "search",
    prompt: "Search the web for the latest news on the Mars Perseverance rover.",
    expectedTool: "search_web",
    checkArgs: (a) => /mars|perseverance|rover/i.test(a.query || ""),
  },
  {
    name: "reminder",
    prompt: "Set a reminder to call mom tomorrow at 5pm.",
    expectedTool: "create_reminder",
    checkArgs: (a) => /mom/i.test(a.text || "") && /5\s*(pm|p\.m\.)|17:00/i.test(a.time || ""),
  },
  {
    name: "no-tool-needed",
    prompt: "What is the capital of France? Answer in one word, no tool needed.",
    expectedTool: null, // should NOT call a tool
    checkArgs: null,
  },
];

const ACCURACY_TESTS = [
  { name: "capital", prompt: "What is the capital of Australia? Answer with just the city name.", check: (t) => /canberra/i.test(t) },
  { name: "speed-math", prompt: "A train travels 60 miles in 1.5 hours. What is its average speed in mph? Answer with just the number.", check: (t) => /\b40\b/.test(t) },
  { name: "decimal-compare", prompt: "Which is bigger: 0.9 or 0.89? Answer with just the number.", check: (t) => /\b0\.9\b/.test(t) },
  { name: "word-problem", prompt: "I have 3 apples, eat one, then buy 5 more. How many apples do I have? Answer with just the number.", check: (t) => /\b7\b/.test(t) },
  { name: "antonym", prompt: "What is the opposite of hot? Answer with just the word.", check: (t) => /\bcold\b/i.test(t) },
  { name: "continents", prompt: "How many continents are there on Earth? Answer with just the number.", check: (t) => /\b7\b/.test(t) },
  { name: "reverse-spell", prompt: "Spell the word 'necessary' backwards, letters only, no spaces.", check: (t) => /yrassecen/i.test(t.replace(/[^a-z]/gi, "")) },
];

// ---------------------------------------------------------------------------
// Coding-agent tests - same tool schema coding-orchestrator/src/pipeline.ts
// actually binds (run_command/write_file), to gauge whether a model could
// drive that agent loop, not just generic tool-calling.
// ---------------------------------------------------------------------------
const CODING_TOOLS = [
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

const CODING_TOOL_TESTS = [
  {
    name: "run-tests",
    prompt: "Run the project's test suite using npm.",
    expectedTool: "run_command",
    checkArgs: (a) => /npm (test|run test)/i.test(a.command || ""),
  },
  {
    name: "write-file",
    prompt:
      "Create a file called hello.py that defines a function greet() returning the string 'Hello, World!'.",
    expectedTool: "write_file",
    checkArgs: (a) =>
      /hello\.py/i.test(a.filename || "") && /def\s+greet/.test(a.content || "") && /Hello, World!/.test(a.content || ""),
  },
];

const CODING_ACCURACY_TESTS = [
  {
    name: "off-by-one",
    prompt:
      "This Python loop is meant to print the numbers 1 through 10 inclusive:\n\nfor i in range(10):\n    print(i)\n\n" +
      "In one short sentence, what's wrong with it?",
    check: (t) => /range\(1,\s*11\)|starts? at 0|0 to 9|0 through 9|doesn'?t include 10|missing 10/i.test(t),
  },
  {
    name: "reverse-string",
    prompt: "Write a single line of Python that reverses the string stored in variable s. Answer with just the code.",
    check: (t) => /s\s*\[\s*::\s*-1\s*\]/.test(t),
  },
  {
    name: "find-bug",
    prompt:
      "This JavaScript function is supposed to return the sum of an array but always returns 0:\n\n" +
      "function sum(arr) {\n  let total = 0;\n  arr.forEach(n => { let total = total + n; });\n  return total;\n}\n\n" +
      "In one short sentence, what's the bug?",
    check: (t) => /shadow|redeclar|inner|local|scope|block-scoped|block scoped|new variable/i.test(t),
  },
];

const LATENCY_PROMPT = "Write a two-sentence summary of why the sky is blue.";

// ---------------------------------------------------------------------------
// Ollama streaming client
// ---------------------------------------------------------------------------
async function chat(model, messages, { tools } = {}) {
  const start = performance.now();
  let ttftMs = null;
  let content = "";
  const toolCalls = [];
  let stats = null;

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      tools,
      think,
      stream: true,
      options: { temperature: 0, num_predict: 300 },
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`${model}: request failed ${res.status} ${res.statusText}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    if (ttftMs === null) ttftMs = performance.now() - start;
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const evt = JSON.parse(trimmed);
      if (evt.message?.content) content += evt.message.content;
      if (evt.message?.tool_calls?.length) toolCalls.push(...evt.message.tool_calls);
      if (evt.done) {
        stats = {
          total_duration_ms: evt.total_duration / 1e6,
          load_duration_ms: evt.load_duration / 1e6,
          prompt_eval_count: evt.prompt_eval_count,
          eval_count: evt.eval_count,
          eval_duration_ms: evt.eval_duration ? evt.eval_duration / 1e6 : null,
        };
      }
    }
  }
  const totalMs = performance.now() - start;

  const tokensPerSec =
    stats?.eval_count && stats?.eval_duration_ms ? stats.eval_count / (stats.eval_duration_ms / 1000) : null;

  return { content, toolCalls, ttftMs, totalMs, stats, tokensPerSec };
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

// ---------------------------------------------------------------------------
// Per-model benchmark
// ---------------------------------------------------------------------------
async function benchmarkModel(model) {
  console.error(`\n=== ${model} ===`);
  const result = {
    model,
    toolTests: [],
    accuracyTests: [],
    codingToolTests: [],
    codingAccuracyTests: [],
    latencyRuns: [],
    errors: [],
  };

  // Warmup: load the model into VRAM before timing anything.
  try {
    console.error("  warming up...");
    await chat(model, [{ role: "user", content: "hi" }]);
  } catch (err) {
    console.error(`  warmup failed: ${err.message}`);
    result.errors.push(`warmup: ${err.message}`);
    return result;
  }

  // Tool-calling tests
  for (const test of TOOL_TESTS) {
    try {
      const r = await chat(model, [{ role: "user", content: test.prompt }], { tools: TOOLS });
      let pass;
      let detail;
      if (test.expectedTool === null) {
        pass = r.toolCalls.length === 0;
        detail = pass ? "no tool called (correct)" : `unexpectedly called ${r.toolCalls.map((c) => c.function?.name).join(",")}`;
      } else {
        const match = r.toolCalls.find((c) => c.function?.name === test.expectedTool);
        pass = !!match && test.checkArgs(parseArgs(match));
        detail = match
          ? `called ${test.expectedTool}(${JSON.stringify(parseArgs(match))})`
          : r.toolCalls.length
          ? `called wrong tool: ${r.toolCalls.map((c) => c.function?.name).join(",")}`
          : "no tool called";
      }
      console.error(`  [tool] ${test.name}: ${pass ? "PASS" : "FAIL"} — ${detail} (${r.totalMs.toFixed(0)}ms)`);
      result.toolTests.push({ name: test.name, pass, detail, ttftMs: r.ttftMs, totalMs: r.totalMs });
    } catch (err) {
      console.error(`  [tool] ${test.name}: ERROR — ${err.message}`);
      result.toolTests.push({ name: test.name, pass: false, detail: `error: ${err.message}` });
    }
  }

  // General accuracy tests
  for (const test of ACCURACY_TESTS) {
    try {
      const r = await chat(model, [{ role: "user", content: test.prompt }]);
      const pass = test.check(r.content);
      console.error(`  [acc]  ${test.name}: ${pass ? "PASS" : "FAIL"} — "${r.content.trim().slice(0, 60)}" (${r.totalMs.toFixed(0)}ms)`);
      result.accuracyTests.push({ name: test.name, pass, response: r.content.trim(), ttftMs: r.ttftMs, totalMs: r.totalMs });
    } catch (err) {
      console.error(`  [acc]  ${test.name}: ERROR — ${err.message}`);
      result.accuracyTests.push({ name: test.name, pass: false, response: `error: ${err.message}` });
    }
  }

  // Coding tool-calling tests (same schema coding-orchestrator binds)
  for (const test of CODING_TOOL_TESTS) {
    try {
      const r = await chat(model, [{ role: "user", content: test.prompt }], { tools: CODING_TOOLS });
      const match = r.toolCalls.find((c) => c.function?.name === test.expectedTool);
      const pass = !!match && test.checkArgs(parseArgs(match));
      const detail = match
        ? `called ${test.expectedTool}(${JSON.stringify(parseArgs(match)).slice(0, 120)})`
        : r.toolCalls.length
        ? `called wrong tool: ${r.toolCalls.map((c) => c.function?.name).join(",")}`
        : "no tool called";
      console.error(`  [code-tool] ${test.name}: ${pass ? "PASS" : "FAIL"} — ${detail} (${r.totalMs.toFixed(0)}ms)`);
      result.codingToolTests.push({ name: test.name, pass, detail, ttftMs: r.ttftMs, totalMs: r.totalMs });
    } catch (err) {
      console.error(`  [code-tool] ${test.name}: ERROR — ${err.message}`);
      result.codingToolTests.push({ name: test.name, pass: false, detail: `error: ${err.message}` });
    }
  }

  // Coding accuracy/reasoning tests
  for (const test of CODING_ACCURACY_TESTS) {
    try {
      const r = await chat(model, [{ role: "user", content: test.prompt }]);
      const pass = test.check(r.content);
      console.error(`  [code-acc]  ${test.name}: ${pass ? "PASS" : "FAIL"} — "${r.content.trim().slice(0, 60)}" (${r.totalMs.toFixed(0)}ms)`);
      result.codingAccuracyTests.push({ name: test.name, pass, response: r.content.trim(), ttftMs: r.ttftMs, totalMs: r.totalMs });
    } catch (err) {
      console.error(`  [code-acc]  ${test.name}: ERROR — ${err.message}`);
      result.codingAccuracyTests.push({ name: test.name, pass: false, response: `error: ${err.message}` });
    }
  }

  // Latency reps (fixed prompt, repeated)
  for (let i = 0; i < reps; i++) {
    try {
      const r = await chat(model, [{ role: "user", content: LATENCY_PROMPT }]);
      console.error(`  [lat]  rep ${i + 1}: ttft=${r.ttftMs.toFixed(0)}ms total=${r.totalMs.toFixed(0)}ms tok/s=${r.tokensPerSec?.toFixed(1)}`);
      result.latencyRuns.push({ ttftMs: r.ttftMs, totalMs: r.totalMs, tokensPerSec: r.tokensPerSec, evalCount: r.stats?.eval_count });
    } catch (err) {
      console.error(`  [lat]  rep ${i + 1}: ERROR — ${err.message}`);
      result.errors.push(`latency rep ${i + 1}: ${err.message}`);
    }
  }

  return result;
}

function avg(arr) {
  const vals = arr.filter((v) => typeof v === "number" && !Number.isNaN(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function summarize(result) {
  const toolPassRate = result.toolTests.length ? result.toolTests.filter((t) => t.pass).length / result.toolTests.length : null;
  const accPassRate = result.accuracyTests.length ? result.accuracyTests.filter((t) => t.pass).length / result.accuracyTests.length : null;
  const codeToolPassRate = result.codingToolTests.length
    ? result.codingToolTests.filter((t) => t.pass).length / result.codingToolTests.length
    : null;
  const codeAccPassRate = result.codingAccuracyTests.length
    ? result.codingAccuracyTests.filter((t) => t.pass).length / result.codingAccuracyTests.length
    : null;
  return {
    model: result.model,
    toolAccuracyPct: toolPassRate !== null ? +(toolPassRate * 100).toFixed(1) : null,
    generalAccuracyPct: accPassRate !== null ? +(accPassRate * 100).toFixed(1) : null,
    codingToolPct: codeToolPassRate !== null ? +(codeToolPassRate * 100).toFixed(1) : null,
    codingAccuracyPct: codeAccPassRate !== null ? +(codeAccPassRate * 100).toFixed(1) : null,
    avgTtftMs: avg(result.latencyRuns.map((r) => r.ttftMs))?.toFixed(0) ?? null,
    avgTotalMs: avg(result.latencyRuns.map((r) => r.totalMs))?.toFixed(0) ?? null,
    avgTokensPerSec: avg(result.latencyRuns.map((r) => r.tokensPerSec))?.toFixed(1) ?? null,
    errors: result.errors.length,
  };
}

function printTable(summaries) {
  const cols = [
    "model",
    "toolAccuracyPct",
    "generalAccuracyPct",
    "codingToolPct",
    "codingAccuracyPct",
    "avgTtftMs",
    "avgTotalMs",
    "avgTokensPerSec",
    "errors",
  ];
  const headers = ["Model", "Tool-call %", "Accuracy %", "Code-tool %", "Code-acc %", "TTFT ms", "Total ms", "Tok/s", "Errors"];
  const widths = cols.map((c, i) => Math.max(headers[i].length, ...summaries.map((s) => String(s[c] ?? "-").length)) + 2);

  const line = (vals) => vals.map((v, i) => String(v ?? "-").padEnd(widths[i])).join("");
  console.log("\n" + line(headers));
  console.log(widths.map((w) => "-".repeat(w - 1)).join(" "));
  for (const s of summaries) console.log(line(cols.map((c) => s[c])));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const allResults = [];
for (const model of models) {
  const result = await benchmarkModel(model);
  allResults.push(result);
}

const summaries = allResults.map(summarize);
printTable(summaries);

const resultsDir = join(__dirname, "benchmark-results");
mkdirSync(resultsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const jsonPath = join(resultsDir, `${stamp}.json`);
const mdPath = join(resultsDir, `${stamp}.md`);

writeFileSync(jsonPath, JSON.stringify({ config: { models, reps, think }, results: allResults, summaries }, null, 2));

const mdRows = summaries
  .map(
    (s) =>
      `| ${s.model} | ${s.toolAccuracyPct ?? "-"} | ${s.generalAccuracyPct ?? "-"} | ${s.codingToolPct ?? "-"} | ${s.codingAccuracyPct ?? "-"} | ${s.avgTtftMs ?? "-"} | ${s.avgTotalMs ?? "-"} | ${s.avgTokensPerSec ?? "-"} | ${s.errors} |`,
  )
  .join("\n");
writeFileSync(
  mdPath,
  `# Model benchmark — ${stamp}\n\nthink=${think}, reps=${reps}\n\n| Model | Tool-call % | Accuracy % | Code-tool % | Code-acc % | TTFT ms | Total ms | Tok/s | Errors |\n|---|---|---|---|---|---|---|---|---|\n${mdRows}\n`
);

console.log(`\nWrote ${jsonPath}\nWrote ${mdPath}`);
