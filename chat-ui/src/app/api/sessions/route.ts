import { NextResponse } from "next/server";
import { listRealSessions } from "@/lib/honcho-client";

// Real, live-verified finding: Honcho (an external cloud service) had a
// transient connect-timeout outage during this session - listRealSessions
// threw unhandled, this route 500'd, and the client-side crash that
// followed took the whole chat page down with it, not just the session
// sidebar. Honcho being briefly unreachable is a real, recurring
// possibility for any service depending on it, not a one-off - degrades to
// an empty session list instead, same "clear degradation, not a crash"
// pattern already used everywhere else in this project.
export async function GET() {
  try {
    const sessions = await listRealSessions();
    return NextResponse.json(sessions);
  } catch (e) {
    console.error("failed to list sessions:", e);
    return NextResponse.json([]);
  }
}
