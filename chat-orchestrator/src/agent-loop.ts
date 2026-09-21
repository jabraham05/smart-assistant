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
  // Prior turns from session-memory.ts's short-term buffer, oldest first -
  // the replacement for LangChain's Postgres Chat Memory node injecting
  // recent history into the AI Agent automatically. Permanently protected
  // from mid-loop trimming, same as the system/current-user messages.
  history?: OllamaMessage[];
  tools: AgentTool[];
  maxIterations: number;
  label?: string;
  numCtx?: number;
  // Called once per iteration a tool_calls response is seen, before the
  // tools actually execute - lets the caller know an action tool was
  // genuinely invoked this turn (see safety-net.ts's confabulation check),
  // without agent-loop.ts itself needing to know what an "action tool" is.
  onToolCalls?: (names: string[]) => void;
}

export interface AgentLoopResult {
  output: string;
  iterations: number;
  exhaustedIterations: boolean;
}

// Caps a single tool result before it ever enters the message history -
// same reasoning as coding-orchestrator's own agent-loop.ts: keeps head and
// tail rather than just the head, since the actual error/answer usually
// sits at the end.
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

const CHARS_PER_TOKEN_ESTIMATE = 4;

function estimateChars(messages: OllamaMessage[]): number {
  return messages.reduce((sum, m) => sum + m.content.length, 0);
}

// Same trimming strategy as coding-orchestrator/src/agent-loop.ts: drop
// the oldest assistant/tool exchanges once history threatens to exceed the
// model's context window. `protectedCount` covers the system message plus
// the short-term conversation history plus the current user message (see
// runAgentLoop below) - only tool-call exchanges accumulated during THIS
// turn's own loop are ever eligible for trimming, never the prior-turns
// context or the message currently being answered.
export function trimHistoryToBudget(messages: OllamaMessage[], numCtx: number, protectedCount: number): OllamaMessage[] {
  const budgetChars = numCtx * CHARS_PER_TOKEN_ESTIMATE * 0.6;
  if (messages.length <= protectedCount + 2 || estimateChars(messages) <= budgetChars) return messages;

  const head = messages.slice(0, protectedCount);
  const tail = messages.slice(protectedCount);
  let droppedCount = 0;

  while (tail.length > 0 && estimateChars([...head, ...tail]) > budgetChars) {
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
      content: `[${droppedCount} earlier tool call(s)/result(s) omitted to stay within context.]`,
    },
    ...tail,
  ];
}

function summarizeCall(name: string, args: Record<string, unknown>): string {
  const preview = (v: unknown) => String(v).replace(/\s+/g, " ").slice(0, 80);
  const firstString = Object.values(args).find((v) => typeof v === "string");
  return firstString ? preview(firstString) : "(no string args)";
}

// The direct replacement for n8n's AI Agent + MCP Client Tool node: call
// the model with a tool set, execute any tool_calls it requests, feed
// results back, repeat until it returns a final text answer or
// maxIterations is hit. Same structural tool_calls detection
// coding-orchestrator/src/agent-loop.ts already proved reliable for
// qwen3:8b via raw HTTP - this is that exact pattern, just fed a
// per-request, classifier-filtered tool set from a real MCP client instead
// of a fixed local array.
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const toolsByName = new Map(options.tools.map((t) => [t.name, t]));
  const ollamaTools: OllamaTool[] = options.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const numCtx = options.numCtx ?? DEFAULT_NUM_CTX;
  const history = options.history ?? [];
  const protectedCount = 2 + history.length;
  let messages: OllamaMessage[] = [
    { role: "system", content: options.systemPrompt },
    ...history,
    { role: "user", content: options.userPrompt },
  ];

  for (let iteration = 1; iteration <= options.maxIterations; iteration++) {
    messages = trimHistoryToBudget(messages, numCtx, protectedCount);
    const { message } = await ollamaChat(options.ollamaHost, {
      model: options.model,
      messages,
      tools: ollamaTools,
      numCtx,
    });

    const toolCalls = message.tool_calls ?? [];

    if (toolCalls.length === 0) {
      const output = message.content ?? "";
      if (!output.trim()) {
        console.log(
          `chat agent-loop${options.label ? ` [${options.label}]` : ""}: empty final reply on ` +
            `iteration ${iteration}/${options.maxIterations} (zero tool calls, empty content)`,
        );
      }
      return { output, iterations: iteration, exhaustedIterations: false };
    }

    options.onToolCalls?.(toolCalls.map((c) => c.function.name));

    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: toolCalls });

    console.log(
      `chat agent-loop${options.label ? ` [${options.label}]` : ""}: iteration ${iteration}/${options.maxIterations} - ` +
        toolCalls.map((c) => `${c.function.name}(${summarizeCall(c.function.name, c.function.arguments)})`).join(", "),
    );

    for (const call of toolCalls) {
      const tool = toolsByName.get(call.function.name);
      const resultText = tool
        ? await tool
            .execute(call.function.arguments)
            .then((r) => truncateToolResult(r))
            .catch((e) => `Error: ${e instanceof Error ? e.message : String(e)}`)
        : `Error: unknown tool "${call.function.name}"`;
      messages.push({ role: "tool", content: resultText });
    }
  }

  console.log(
    `chat agent-loop${options.label ? ` [${options.label}]` : ""}: exhausted all ${options.maxIterations} ` +
      `iterations without a final (no-tool-call) reply`,
  );
  return { output: "", iterations: options.maxIterations, exhaustedIterations: true };
}
