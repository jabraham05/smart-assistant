import { NextRequest, NextResponse } from "next/server";
import { listRecentEvents } from "@/lib/event-bus-client";

export async function GET(req: NextRequest) {
  const limitParam = req.nextUrl.searchParams.get("limit");
  const source = req.nextUrl.searchParams.get("source") ?? undefined;
  const limit = limitParam ? Number(limitParam) : 50;

  try {
    const events = await listRecentEvents(Number.isFinite(limit) ? limit : 50, source);
    return NextResponse.json(events);
  } catch (e) {
    console.error("failed to fetch events from event-bus:", e);
    return NextResponse.json({ error: "failed to reach event-bus" }, { status: 502 });
  }
}
