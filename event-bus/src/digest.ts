import type { Config } from "./config.js";
import * as db from "./db.js";
import { tavilyNewsSearch } from "./lib/tavily.js";
import { notifyOwnerDirect } from "./discord-notify.js";

function hoursSince(date: Date): number {
  return (Date.now() - date.getTime()) / 3_600_000;
}

// One-off raw Ollama call, not routed through any existing chat/agent
// path - this is the one genuinely new LLM call in event-bus (everything
// else here is deliberately deterministic). Summarizing real search
// results into a short, conversational briefing is a real writing/
// judgment task, not something a keyword rule could do - see the
// architecture plan's reasoning for keeping this one LLM call while the
// trigger detection (isWakeEvent) and cooldown gating around it stay
// plain code.
async function summarizeNews(config: Config, articles: { title: string; content: string }[]): Promise<string> {
  const raw = articles.map((a) => `- ${a.title}: ${a.content.slice(0, 300)}`).join("\n");
  const res = await fetch(`${config.ollamaHost}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.digestModel,
      stream: false,
      messages: [
        {
          role: "user",
          content:
            "Summarize today's most important news into a short, conversational morning briefing " +
            "(4-6 sentences, no headers or bullet points, like catching a friend up) covering both " +
            "global and US stories, based only on these real articles:\n\n" +
            raw,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`ollama chat failed: ${res.status}`);
  const data = (await res.json()) as { message?: { content?: string } };
  return data.message?.content?.trim() ?? "";
}

async function buildNewsSection(config: Config): Promise<string> {
  if (!config.tavilyApiKey) return "";
  try {
    const [global, us] = await Promise.all([
      tavilyNewsSearch(config.tavilyApiKey, "top world news today"),
      tavilyNewsSearch(config.tavilyApiKey, "top US news today"),
    ]);
    const articles = [...global, ...us];
    if (articles.length === 0) return "";
    return await summarizeNews(config, articles);
  } catch (e) {
    console.error("overnight digest: news fetch/synthesis failed:", e);
    return "";
  }
}

export interface DigestRunResult {
  sent: boolean;
  reason?: string;
}

// The actual digest send, gated by its own cooldown independent of
// whatever triggered this check (a calendar wake event, a manual test
// call, or - if this scanner is ever polled on a fixed schedule too - a
// missed calendar detection). Never sends an empty "nothing happened"
// message.
export async function runOvernightDigest(config: Config): Promise<DigestRunResult> {
  const lastMessaged = await db.getScannerLastRun(config, "overnight_digest_message");
  if (hoursSince(lastMessaged) < config.overnightDigestMinHours) {
    return { sent: false, reason: "cooldown" };
  }

  const pending = await db.getPendingDigestEvents(config);
  const overnightSection = pending
    .map((p) => (typeof p.payload.summary === "string" ? p.payload.summary : null))
    .filter((s): s is string => !!s)
    .map((s) => `- ${s}`)
    .join("\n");

  const newsSection = await buildNewsSection(config);

  await db.touchScannerLastRun(config, "overnight_digest");

  if (!overnightSection && !newsSection) {
    return { sent: false, reason: "nothing to report" };
  }

  const parts: string[] = [];
  if (overnightSection) parts.push(`Here's what happened overnight:\n${overnightSection}`);
  if (newsSection) parts.push(`And here's today's news:\n\n${newsSection}`);
  const message = `Morning! ${parts.join("\n\n")}`;

  await notifyOwnerDirect(config, message);
  await Promise.all(pending.map((p) => db.markEventStatus(config, p.id, "notified", true)));
  await db.touchScannerLastRun(config, "overnight_digest_message");

  return { sent: true };
}
