import { NextResponse } from "next/server";
import { getHomeSummary } from "@/lib/event-bus-client";

export async function GET() {
  try {
    const summary = await getHomeSummary();
    return NextResponse.json(summary);
  } catch (e) {
    console.error("failed to fetch home summary from event-bus:", e);
    return NextResponse.json({ error: "failed to reach event-bus" }, { status: 502 });
  }
}
