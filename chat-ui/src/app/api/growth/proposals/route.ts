import { NextRequest, NextResponse } from "next/server";
import { listGrowthProposals } from "@/lib/growth-client";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  try {
    const proposals = await listGrowthProposals(status);
    return NextResponse.json({ proposals });
  } catch (e) {
    console.error("failed to fetch growth proposals from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
