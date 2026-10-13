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
  // Ollama native-API field, distinct from the server-wide OLLAMA_KEEP_ALIVE
  // default (docker-compose.yml's "-1", i.e. never expire). That default
  // means every model that ever loads - including the much bigger
  // qwen3:14b planner/reviewer - pins itself in VRAM forever once used,
  // evicting whatever else was resident (the resident chat model, most
  // disruptively) with nothing to ever give that VRAM back. Pass a short
  // value here specifically for the planner/reviewer call sites so qwen3:14b
  // self-evicts shortly after a coding task's planning/review step finishes,
  // instead of permanently ratcheting VRAM away from live chat.
  keepAlive?: string;
}

// Matches the ollama service's OLLAMA_CONTEXT_LENGTH in docker-compose.yml
// (16384, bumped from 8192 after checking real GPU headroom - see that
// file's comment). Set explicitly per request rather than relying on the
// server default implicitly: agent-loop.ts's Coder/Tester loop accumulates
// every tool call/result into the message history across up to 25
// iterations, a real, observed contributor to empty-output failures when
// the effective context runs out mid-loop.
export const DEFAULT_NUM_CTX = 16384;

export interface OllamaChatResult {
  message: OllamaMessage;
}

// Plain or tool-calling chat completion, always non-streaming - the
// orchestrator only ever needs a single complete response per call, never
// token-by-token delivery (unlike the old n8n Chat workflow, which streams
// to the user directly).
export async function ollamaChat(ollamaHost: string, options: OllamaChatOptions): Promise<OllamaChatResult> {
  const controller = new AbortController();
  // Generous default - this is a background task, not a live chat response,
  // and a single shared Ollama/GPU instance under real contention (several
  // coding tasks or a model swap between qwen3:8b/14b happening at once)
  // can genuinely take a while per call. Observed live: concurrent task
  // testing aborted real in-progress calls at 120s under exactly this kind
  // of contention.
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 240_000);

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
        ...(options.keepAlive ? { keep_alive: options.keepAlive } : {}),
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
// its answer in something that isn't valid JSON (matching the same
// defensive "parsed = {}" fallback used throughout the old n8n workflow's
// Code nodes, e.g. Parse Plan / Parse Reviewer Output).
export function parseJsonContent<T>(content: string, fallback: T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}
