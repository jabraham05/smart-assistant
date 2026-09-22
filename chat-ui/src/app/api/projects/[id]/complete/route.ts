import { NextResponse } from "next/server";
import { completeProject } from "@/lib/knowledge-engine-client";

export async function POST(_req: Request, ctx: RouteContext<"/api/projects/[id]/complete">) {
  const { id } = await ctx.params;
  try {
    const project = await completeProject(Number(id));
    return NextResponse.json(project);
  } catch (e) {
    // 409s from knowledge-engine (e.g. "research not finished yet") surface
    // here as a plain error message the dashboard shows inline, not a hard
    // failure - the user just needs to wait and try again.
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
