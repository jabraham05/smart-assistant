import { NextResponse } from "next/server";
import { rejectProject } from "@/lib/knowledge-engine-client";

export async function POST(_req: Request, ctx: RouteContext<"/api/projects/[id]/reject">) {
  const { id } = await ctx.params;
  try {
    const project = await rejectProject(Number(id));
    return NextResponse.json(project);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
