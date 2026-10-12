import { NextRequest, NextResponse } from "next/server";
import { listTeachingSessions } from "@/lib/growth-client";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  try {
    const teachingSessions = await listTeachingSessions(status);
    return NextResponse.json({ teachingSessions });
  } catch (e) {
    console.error("failed to fetch teaching sessions from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
