import { NextRequest, NextResponse } from "next/server";
import { listLearningPlans } from "@/lib/growth-client";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  try {
    const learningPlans = await listLearningPlans(status);
    return NextResponse.json({ learningPlans });
  } catch (e) {
    console.error("failed to fetch learning plans from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
