export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaChatOptions {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  think?: boolean;
  format?: Record<string, unknown>;
  timeoutMs?: number;
  numCtx?: number;
}

// Matches OLLAMA_CONTEXT_LENGTH in docker-compose.yml (16384). Set
// explicitly per request rather than relying on the server default
// implicitly - same reasoning as coding-orchestrator/src/ollama.ts, this
// loop can accumulate several tool calls/results into the message history
// across up to agentMaxIterations turns.
export const DEFAULT_NUM_CTX = 16384;

export interface OllamaChatResult {
  message: OllamaMessage;
}

// Plain or tool-calling chat completion, always non-streaming - the
// orchestrator's own reply to the caller is streamed separately (see
// server.ts), one token-stream per whole turn, not per Ollama call.
export async function ollamaChat(ollamaHost: string, options: OllamaChatOptions): Promise<OllamaChatResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);

  try {
    const res = await fetch(`${ollamaHost}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        stream: false,
        think: options.think ?? false,
        messages: options.messages,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.format ? { format: options.format } : {}),
        options: { num_ctx: options.numCtx ?? DEFAULT_NUM_CTX },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama chat failed: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { message: OllamaMessage };
    return { message: data.message };
  } finally {
    clearTimeout(timeout);
  }
}

// Parses a structured-output JSON response, tolerating a model that wraps
// its answer in something that isn't valid JSON.
export function parseJsonContent<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}
