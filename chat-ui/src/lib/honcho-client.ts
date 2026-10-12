import type { EnrichedSession, HonchoMessage, HonchoSession, SessionOrigin } from "@/types/chat";
import type { MessagePage } from "@/lib/message-paging";

// Server-side only: the API key never reaches the browser.
const HONCHO_API_KEY = process.env.HONCHO_API_KEY;
const HONCHO_WORKSPACE_ID = process.env.HONCHO_WORKSPACE_ID ?? "smart-assistant";
const HONCHO_BASE_URL = "https://api.honcho.dev/v3";

function requireApiKey(): string {
  if (!HONCHO_API_KEY) {
    throw new Error("HONCHO_API_KEY is not configured");
  }
  return HONCHO_API_KEY;
}

async function honchoPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${HONCHO_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Honcho request to ${path} failed with ${res.status}`);
  }

  return res.json();
}

// reverse/size are real query params on this endpoint (same Page[Session]/
// apaginate shape as messages.py's get_messages route, confirmed directly
// against honcho-src/src/routers/sessions.py). Without them this silently
// returned page 1 of Honcho's default page size, oldest-first - once real
// usage pushed the total session count past that page size, every session
// created after the cutoff (a real, growing set of actual conversations,
// not test data) simply never appeared in the sidebar at all, while old
// test sessions from weeks ago stayed visible. reverse=true (newest first)
// + a generous size means any future overflow drops the *oldest*, least
// useful sessions instead of hiding the newest, most useful ones.
export async function listSessions(): Promise<HonchoSession[]> {
  const data = await honchoPost<{ items: HonchoSession[] }>(
    // 100 is this endpoint's real hard max (confirmed live: size=200 gets
    // rejected outright with a 422 "Input should be less than or equal to
    // 100" - not silently clamped), so 100 is the largest page reverse=true
    // can actually pull in one call.
    `/workspaces/${HONCHO_WORKSPACE_ID}/sessions/list?reverse=true&size=100`,
    { filters: {} }
  );
  return data.items;
}

// With `paging`, returns that page newest-first (reverse=true) - see
// lib/message-paging.ts. Without it, the original oldest-first first page.
export async function getSessionMessages(sessionId: string, paging?: MessagePage | null): Promise<HonchoMessage[]> {
  const query = paging ? `?reverse=true&size=${paging.size}&page=${paging.page}` : "";
  const data = await honchoPost<{ items: HonchoMessage[] }>(
    `/workspaces/${HONCHO_WORKSPACE_ID}/sessions/${sessionId}/messages/list${query}`,
    {}
  );
  return data.items;
}

// reverse/size are real query params on this endpoint (confirmed directly
// against honcho-src/src/routers/messages.py's get_messages route - it's
// a plain FastAPI-Pagination Page[Message], reverse is a query bool, size
// is the standard pagination page-size param), used here to fetch just
// one message instead of a whole session's history.
async function getOneMessage(sessionId: string, reverse: boolean): Promise<HonchoMessage | undefined> {
  const data = await honchoPost<{ items: HonchoMessage[] }>(
    `/workspaces/${HONCHO_WORKSPACE_ID}/sessions/${sessionId}/messages/list?reverse=${reverse}&size=1`,
    {}
  );
  return data.items[0];
}

function sessionOrigin(sessionId: string): SessionOrigin {
  if (sessionId.startsWith("discord-")) return "discord";
  if (sessionId.startsWith("cli-")) return "cli";
  return "chat";
}

function previewText(content: string, maxLength = 80): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…` : flat;
}

// A real chat turn always inserts a user+amy pair together (see the
// message-insert code in chat-orchestrator's src/honcho.ts and the old
// Chat workflow before it) - a one-way background notification
// (coding-orchestrator's notifyOrigin, event-bus's stale-goal nudge) only
// ever inserts a lone 'amy' message, so its first message is never
// 'user'. Same heuristic docs/skill-gap-scanner.md already validated for
// telling genuine conversations apart from notification-only sessions
// (confirmed there: correctly separated 9 real conversations out of 30
// raw sessions in this workspace's real data).
async function enrichSession(session: HonchoSession): Promise<EnrichedSession | undefined> {
  const [first, last] = await Promise.all([
    getOneMessage(session.id, false),
    getOneMessage(session.id, true),
  ]);
  if (!first || first.peer_id !== "user" || !last) return undefined;

  return {
    ...session,
    origin: sessionOrigin(session.id),
    lastMessageAt: last.created_at,
    preview: previewText(last.content),
  };
}

// The real fix for "chats don't show up properly": raw sessions/list is
// unfiltered (includes one-way notification sessions) and has no notion
// of recency beyond creation time, which buries a long-lived session
// (e.g. Discord's one stable session per user, reused indefinitely) at
// whatever position its *original* creation date puts it at, however
// recently it was actually used. Filters to genuine conversations only
// and sorts by real last-message time. One extra pair of small requests
// per session - acceptable for a personal dashboard's manual refresh,
// not a hot path.
export async function listRealSessions(): Promise<EnrichedSession[]> {
  const sessions = await listSessions();
  const enriched = await Promise.all(
    sessions.map((s) =>
      enrichSession(s).catch((e) => {
        console.error(`failed to enrich session ${s.id}:`, e);
        return undefined;
      })
    )
  );
  return enriched
    .filter((s): s is EnrichedSession => !!s)
    .sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
}
