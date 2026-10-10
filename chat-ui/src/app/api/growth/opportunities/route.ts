import { NextRequest, NextResponse } from "next/server";
import { listGrowthOpportunities } from "@/lib/growth-client";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  try {
    const opportunities = await listGrowthOpportunities(status);
    return NextResponse.json({ opportunities });
  } catch (e) {
    console.error("failed to fetch growth opportunities from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
