import type { Config } from "./config.js";
import type { MemorySearchRow } from "./db.js";

// One deliberately-LLM step in an otherwise deterministic search - turning
// raw matched snippets into a short digest is a real writing/judgment
// task, the same reasoning event-bus's digest.ts already uses for
// summarizing news articles. Never invents anything not present in the
// snippets - the prompt is explicit about that, and this is a summary of
// real retrieved content, not a free-form answer.
export async function synthesizeMemories(config: Config, query: string, rows: MemorySearchRow[]): Promise<string> {
  const transcript = rows.map((r) => `[${r.role}] ${r.content}`).join("\n");
  const res = await fetch(`${config.ollamaHost}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.synthesisModel,
      stream: false,
      messages: [
        {
          role: "user",
          content:
            "Summarize what's relevant to this question, as a short bullet list, based only on the " +
            "real past conversation snippets below - never add anything not actually present in them. " +
            `If nothing here is genuinely relevant, say so in one line instead of forcing bullets.\n\n` +
            `Question: ${query}\n\nPast snippets:\n${transcript}`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama chat failed: ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content?.trim() ?? "";
}
