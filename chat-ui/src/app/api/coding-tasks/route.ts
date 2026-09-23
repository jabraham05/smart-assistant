import { NextRequest, NextResponse } from "next/server";
import { getCodingTasks } from "@/lib/coding-orchestrator-client";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  try {
    const tasks = await getCodingTasks(status);
    return NextResponse.json({ tasks });
  } catch (e) {
    console.error("failed to fetch coding tasks from coding-orchestrator:", e);
    return NextResponse.json({ error: "failed to reach coding-orchestrator" }, { status: 502 });
  }
}
