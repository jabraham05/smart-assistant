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
      return { output: message.content ?? "", iterations: iteration, exhaustedIterations: false };
    }

    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });

    for (const call of toolCalls) {
      const tool = toolsByName.get(call.function.name);
      const resultText = tool
        ? await tool.execute(call.function.arguments).catch((e) => `Error: ${e instanceof Error ? e.message : String(e)}`)
        : `Error: unknown tool "${call.function.name}"`;
      messages.push({ role: "tool", content: resultText });
    }
  }

  return { output: "", iterations: options.maxIterations, exhaustedIterations: true };
}
