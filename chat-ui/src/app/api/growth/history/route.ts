import { NextRequest, NextResponse } from "next/server";
import { listGrowthHistory } from "@/lib/growth-client";

export async function GET(req: NextRequest) {
  const limitParam = req.nextUrl.searchParams.get("limit");
  try {
    const history = await listGrowthHistory(limitParam ? Number(limitParam) : undefined);
    return NextResponse.json({ history });
  } catch (e) {
    console.error("failed to fetch growth history from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
