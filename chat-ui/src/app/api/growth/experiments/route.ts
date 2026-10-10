import { NextResponse } from "next/server";
import { listGrowthExperiments } from "@/lib/growth-client";

export async function GET() {
  try {
    const experiments = await listGrowthExperiments();
    return NextResponse.json({ experiments });
  } catch (e) {
    console.error("failed to fetch growth experiments from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
