import { DEFAULT_NUM_CTX, ollamaChat, type OllamaMessage, type OllamaTool } from "./ollama.js";

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export interface AgentLoopOptions {
  ollamaHost: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  tools: AgentTool[];
  maxIterations: number;
  // Free-form tag for correlating log lines back to a specific caller/task,
  // e.g. "coder task=13". Optional so existing/future callers aren't forced
  // to supply one; logging just gets less specific without it.
  label?: string;
  // Must match whatever num_ctx the caller actually requests from Ollama
  // (defaults to the same DEFAULT_NUM_CTX ollamaChat itself falls back to)
  // - trimHistoryToBudget below sizes its trim threshold off of this, so a
  // mismatch here would make it trim against the wrong window size.
  numCtx?: number;
}

export interface AgentLoopResult {
  output: string;
  iterations: number;
  // True when the loop ended because it ran out of iterations without the
  // model ever producing a final (no-tool-call) reply - the direct
  // replacement for n8n's "Max iterations (N) reached" agent-node error,
  // now a distinguishable, typed outcome instead of a thrown exception.
  exhaustedIterations: boolean;
}

// Caps a single tool result before it ever enters the message history - one
// `run_command` call (a full test run, a `cat` of a large file) can return
// tens of KB on its own, which alone can eat a large fraction of the context
// budget in a single iteration regardless of how much history trimming
// below does. Keeps head and tail rather than just the head: the command
// that ran is obvious from the start, but the actual error is usually at
// the end of stdout/stderr, not the beginning.
export function truncateToolResult(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.6);
  const tailChars = maxChars - headChars;
  return (
    text.slice(0, headChars) +
    `\n... [truncated ${text.length - maxChars} chars] ...\n` +
    text.slice(text.length - tailChars)
  );
}

// No tokenizer available here for an arbitrary Ollama model, so this is a
// deliberately conservative chars-per-token estimate - trimming should kick
// in before the model actually runs out of context, not after.
const CHARS_PER_TOKEN_ESTIMATE = 4;

function estimateChars(messages: OllamaMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

// Drops the oldest assistant/tool exchanges once the running history
// threatens to exceed the model's context window, replacing them with one
// short marker instead of just letting the model silently lose context mid-
// task. messages[0] (system) and messages[1] (the original task/plan) are
// never dropped - losing the actual task description partway through a
// 25-iteration loop would be far worse than losing an old tool result. This
// is the direct fix for the "empty output near context exhaustion" failure
// ollama.ts's DEFAULT_NUM_CTX comment already documents as a real, observed
// cause, rather than just detecting/logging it after the fact as the rest
// of this file's error paths do.
function trimHistoryToBudget(messages: OllamaMessage[], numCtx: number): OllamaMessage[] {
  // 0.6 leaves room for the tool schemas sent alongside every request and
  // for the model's own reply, neither of which counts against this total.
  const budgetChars = numCtx * CHARS_PER_TOKEN_ESTIMATE * 0.6;
  if (messages.length <= 4 || estimateChars(messages) <= budgetChars) return messages;

  const head = messages.slice(0, 2);
  const tail = messages.slice(2);
  let droppedCount = 0;

  // Each dropped "exchange" is one assistant message (its tool_calls) plus
  // every tool-result message that immediately followed it - shifting until
  // the next non-tool message keeps a dangling tool result from ever being
  // left with no matching assistant call in front of it.
  while (tail.length > 2 && estimateChars([...head, ...tail]) > budgetChars) {
    tail.shift();
    droppedCount++;
    while (tail.length > 0 && tail[0].role === "tool") {
      tail.shift();
      droppedCount++;
    }
  }

  if (droppedCount === 0) return messages;
  return [
    ...head,
    {
      role: "user",
      content:
        `[${droppedCount} earlier tool call(s)/result(s) omitted to stay within context. The work ` +
        "already done from them is still applied in the container - it is not repeated here, just no " +
        "longer shown.]",
    },
    ...tail,
  ];
}

// Short, single-line summary of a tool call for per-iteration tracing -
// deliberately not the full arguments (could be a whole file's content),
// just enough to tell "same command repeated" from "steady progress" apart
// at a glance in the logs.
function summarizeCall(name: string, args: Record<string, unknown>): string {
  const preview = (v: unknown) => String(v).replace(/\s+/g, " ").slice(0, 80);
  if (name === "run_command" && typeof args.command === "string") return preview(args.command);
  if (name === "write_file" && typeof args.filename === "string") return preview(args.filename);
  const firstString = Object.values(args).find((v) => typeof v === "string");
  return firstString ? preview(firstString) : "(no string args)";
}

// Reimplements the ReAct-style tool-calling loop n8n's Agent node + MCP
// Client Tool node provided: call the model with a tool set, execute any
// tool_calls it requests against real tools, feed results back, repeat
// until it returns a final text answer or maxIterations is hit. This is
// the direct replacement for Coder Agent / Coder Agent Retry / Tester
// Agent - one real function, parameterized, instead of three separate
// n8n agent node instances with duplicated retry wiring around them.
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const toolsByName = new Map(options.tools.map((t) => [t.name, t]));
  const ollamaTools: OllamaTool[] = options.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const numCtx = options.numCtx ?? DEFAULT_NUM_CTX;
  let messages: OllamaMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.userPrompt },
  ];

  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    messages = trimHistoryToBudget(messages, numCtx);
    const { message } = await ollamaChat(options.ollamaHost, {
      model: options.model,
      messages,
      tools: ollamaTools,
      numCtx,
    });

    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      // No tool call requested - this is the model's final answer, exactly
      // like n8n's Agent node treating a plain-text reply as completion.
      const output = message.content ?? "";
      if (!output.trim()) {
        // Zero tool calls AND empty content, on iteration N - this is the
        // "no output" case previously indistinguishable from an exhausted
        // loop (see runCoderRound's DB error message). Log enough to tell
        // them apart without dumping full prompts/tool output.
        console.log(
          `agent-loop${options.label ? ` [${options.label}]` : ""}: empty final reply on ` +
            `iteration ${iteration}/${options.maxIterations} (zero tool calls, empty content)`,
        );
      }
      return { output, iterations: iteration, exhaustedIterations: false };
    }

    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });

    console.log(
      `agent-loop${options.label ? ` [${options.label}]` : ""}: iteration ${iteration}/${options.maxIterations} - ` +
        toolCalls.map((c) => `${c.function.name}(${summarizeCall(c.function.name, c.function.arguments)})`).join(", "),
    );

    for (const call of toolCalls) {
      const tool = toolsByName.get(call.function.name);
      const resultText = tool
        ? await tool.execute(call.function.arguments).catch((e) => `Error: ${e instanceof Error ? e.message : String(e)}`)
        : `Error: unknown tool "${call.function.name}"`;
      messages.push({ role: "tool", content: resultText });
    }
  }

  console.log(
    `agent-loop${options.label ? ` [${options.label}]` : ""}: exhausted all ${options.maxIterations} ` +
      `iterations without a final (no-tool-call) reply`,
  );
  return { output: "", iterations: options.maxIterations, exhaustedIterations: true };
}
