// Naive fixed-size chunking on paragraph boundaries, matching
// research_pipeline's known-working ~1000-char target baseline rather than
// inventing a new size with no evidence behind it. Split out as its own
// pure function (no I/O) so it's directly unit-testable, same reasoning as
// event-bus's matchKeywords() extraction.
export function chunkText(text: string, targetSize = 1000): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > targetSize) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
