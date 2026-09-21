import type { Config } from "../config.js";

// Deliberately duplicated from knowledge-engine/src/lib/ollama-embeddings.ts
// rather than shared as a package - same convention this project already
// uses for small cross-service functions (see event-bus/src/notify.ts's
// own comment on the same tradeoff). Identical implementation: batch-
// capable /api/embed, one 768-dim vector per input string.
export async function embedTexts(config: Config, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const response = await fetch(`${config.ollamaHost}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.embeddingModel, input: texts }),
  });

  if (!response.ok) {
    throw new Error(`ollama embed failed: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as { embeddings: number[][] };
  if (data.embeddings.length !== texts.length) {
    throw new Error(`ollama embed returned ${data.embeddings.length} embeddings for ${texts.length} inputs`);
  }
  return data.embeddings;
}

export async function embedText(config: Config, text: string): Promise<number[]> {
  const [embedding] = await embedTexts(config, [text]);
  return embedding;
}
