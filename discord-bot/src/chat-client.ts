// Same NDJSON streaming contract as scripts/chat.mjs: the Chat Trigger's
// responseMode is "streaming", one JSON event per line. Only "item" events
// from the AI Agent node carry actual reply text; everything else
// (begin/end/error, tool-call brackets) is ignored.
//
// "ack" is the one exception: a deterministic, server-emitted acknowledgment
// agent-service sends for a turn it's already decided will be slow (see
// agent-service/src/main.py's should_acknowledge) - never sent for a fast
// turn. Real, live-verified finding: this function used to only return the
// final assembled string once the WHOLE stream ended, so an ack folded into
// that string would still only reach the user after the full wait - zero
// perceived-latency benefit. onAck fires as soon as the ack line arrives,
// well before the rest of the turn (tool calls, the real reply) finishes,
// so the caller can send it as its own, immediate Discord message.
export async function sendChatMessage(
  webhookUrl: string,
  chatInput: string,
  sessionId: string,
  onAck?: (text: string) => void,
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
  // agent-service's outer except (main.py's stream()) emits this whenever
  // something fails OUTSIDE the per-attempt turn wrapper (e.g. classify,
  // system-prompt assembly, Honcho recall) - before any "item" text was
  // ever produced. Real, live-found gap: this event type was previously
  // ignored entirely here, so a failure there streamed to completion with
  // output="" and silently surfaced to the user as the generic
  // "(no response)" fallback below, indistinguishable from an actually-empty
  // valid reply and with the real error visible only in agent-service's own
  // logs. If an error arrives AFTER real reply text already streamed (e.g. a
  // post-turn memory-write failure, which happens after the reply is fully
  // sent), the reply itself is still good - only an empty-output error
  // should become a thrown, user-visible failure.
  let errorMessage: string | null = null;
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
    if (event.type === "ack" && event.content) {
      onAck?.(event.content.trim());
      return;
    }
    if (event.type === "item" && event.metadata?.nodeName === "AI Agent" && event.content) {
      output += event.content;
    }
    if (event.type === "error" && event.content) {
      errorMessage = event.content;
    }
  };

  for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  }
  handleLine(buffer);

  if (!output.trim() && errorMessage) {
    throw new Error(`agent-service turn failed: ${errorMessage}`);
  }

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
