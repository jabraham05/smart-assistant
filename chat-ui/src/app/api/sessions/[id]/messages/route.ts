import { NextResponse } from "next/server";
import { getSessionMessages } from "@/lib/honcho-client";
import { parseMessagePage } from "@/lib/message-paging";

// Same "clear degradation, not a crash" reasoning as /api/sessions - a
// transient Honcho outage (real, live-verified this session: a
// ConnectTimeoutError to api.honcho.dev) must not 500 this route and take
// the chat page down with it. Degrades to an empty history instead -
// useChat.ts's own history-loading effect already handles an empty array
// correctly (a fresh-looking conversation), which is a far better failure
// mode than a crash.
export async function GET(
  req: Request,
  ctx: RouteContext<"/api/sessions/[id]/messages">
) {
  const { id } = await ctx.params;
  try {
    const messages = await getSessionMessages(id, parseMessagePage(new URL(req.url).searchParams));
    return NextResponse.json(messages);
  } catch (e) {
    console.error(`failed to load messages for session ${id}:`, e);
    return NextResponse.json([]);
  }
}
