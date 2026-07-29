// Same NDJSON streaming contract as scripts/chat.mjs: the Chat Trigger's
// responseMode is "streaming", one JSON event per line. Only "item" events
// from the AI Agent node carry actual reply text; everything else
// (begin/end/error, tool-call brackets) is ignored.
export async function sendChatMessage(
  webhookUrl: string,
  chatInput: string,
  sessionId: string,
): Promise<string> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatInput, sessionId }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Chat webhook request failed: ${res.status} ${res.statusText}`);
  }

  let output = "";
  const decoder = new TextDecoder();
  let buffer = "";

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (event.type === "item" && event.metadata?.nodeName === "AI Agent" && event.content) {
      output += event.content;
    }
  };

  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  handleLine(buffer);

  return output;
}

// Discord messages cap at 2000 characters. Split on paragraph/line breaks
// where possible instead of hard-cutting mid-sentence.
export function chunkForDiscord(text: string, maxLength = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
