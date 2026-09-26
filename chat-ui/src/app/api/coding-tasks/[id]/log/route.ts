import { NextResponse } from "next/server";
import { getCodingTaskLog } from "@/lib/coding-orchestrator-client";

export async function GET(_req: Request, ctx: RouteContext<"/api/coding-tasks/[id]/log">) {
  const { id } = await ctx.params;
  try {
    const log = await getCodingTaskLog(Number(id));
    return NextResponse.json({ log });
  } catch (e) {
    console.error(`failed to fetch task log for ${id}:`, e);
    return NextResponse.json({ error: "failed to reach coding-orchestrator" }, { status: 502 });
  }
}
