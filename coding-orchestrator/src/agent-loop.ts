import { ollamaChat, type OllamaMessage, type OllamaTool } from "./ollama.js";

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

  const messages: OllamaMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.userPrompt },
  ];

  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    const { message } = await ollamaChat(options.ollamaHost, {
      model: options.model,
      messages,
      tools: ollamaTools,
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
