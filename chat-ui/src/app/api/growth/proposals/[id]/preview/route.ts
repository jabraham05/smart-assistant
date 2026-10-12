import { NextResponse } from "next/server";
import { previewGrowthProposal } from "@/lib/growth-client";

export async function POST(_req: Request, ctx: RouteContext<"/api/growth/proposals/[id]/preview">) {
  const { id } = await ctx.params;
  try {
    const preview = await previewGrowthProposal(Number(id));
    return NextResponse.json(preview);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
