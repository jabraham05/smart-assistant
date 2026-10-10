import { NextResponse } from "next/server";
import { getGrowthProposal } from "@/lib/growth-client";

export async function GET(_req: Request, ctx: RouteContext<"/api/growth/proposals/[id]">) {
  const { id } = await ctx.params;
  try {
    const proposal = await getGrowthProposal(Number(id));
    return NextResponse.json(proposal);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
