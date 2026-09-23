import { NextRequest, NextResponse } from "next/server";
import { getHomeActivity } from "@/lib/event-bus-client";

export async function GET(req: NextRequest) {
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : 20;

  try {
    const items = await getHomeActivity(Number.isFinite(limit) ? limit : 20);
    return NextResponse.json(items);
  } catch (e) {
    console.error("failed to fetch home activity from event-bus:", e);
    return NextResponse.json({ error: "failed to reach event-bus" }, { status: 502 });
  }
}
