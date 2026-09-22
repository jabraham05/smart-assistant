import { NextResponse } from "next/server";
import { approveProject } from "@/lib/knowledge-engine-client";

export async function POST(_req: Request, ctx: RouteContext<"/api/projects/[id]/approve">) {
  const { id } = await ctx.params;
  try {
    const project = await approveProject(Number(id));
    return NextResponse.json(project);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
