import { NextRequest, NextResponse } from "next/server";
import { getCodingTasks } from "@/lib/coding-orchestrator-client";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  try {
    const tasks = await getCodingTasks(status, limit);
    return NextResponse.json({ tasks });
  } catch (e) {
    console.error("failed to fetch coding tasks from coding-orchestrator:", e);
    return NextResponse.json({ error: "failed to reach coding-orchestrator" }, { status: 502 });
  }
}
