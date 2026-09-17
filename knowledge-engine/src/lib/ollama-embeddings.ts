import type { Config } from "../config.js";

// No reusable Ollama-embedding client existed anywhere in this codebase
// before this - the old research_pipeline embedded one chunk at a time via
// raw HTTP Request nodes inside n8n, hitting the older singular
// /api/embeddings endpoint. Verified directly against the running Ollama
// instance that /api/embed (plural, batch-capable) works and returns one
// 768-dim vector per input string, so ingestion embeds a whole document's
// chunks in one call instead of one round-trip per chunk.
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
