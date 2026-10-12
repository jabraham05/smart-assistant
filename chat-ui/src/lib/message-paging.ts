// Opt-in, newest-first paging for GET /api/sessions/[id]/messages. The
// native app's single long-lived thread needs the *latest* messages first
// and older ones on demand - the unparameterized route returns Honcho's
// first page oldest-first (fine for the PWA's short sessions, wrong for a
// thread that grows forever). No `size`/`page` params = null = the old
// behavior, so the PWA is unaffected.
export interface MessagePage {
  page: number;
  size: number;
}

// Honcho's real hard max page size - see listSessions in honcho-client.ts
// (size=200 is rejected with a 422, not clamped).
export const MAX_MESSAGE_PAGE_SIZE = 100;

export function parseMessagePage(params: URLSearchParams): MessagePage | null {
  if (!params.has("size") && !params.has("page")) return null;
  const size = Number.parseInt(params.get("size") ?? "50", 10);
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    size: Number.isFinite(size) ? Math.min(Math.max(size, 1), MAX_MESSAGE_PAGE_SIZE) : 50,
    page: Number.isFinite(page) ? Math.max(page, 1) : 1,
  };
}
