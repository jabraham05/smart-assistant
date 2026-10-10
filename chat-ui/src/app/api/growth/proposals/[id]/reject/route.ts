import { NextResponse } from "next/server";
import { rejectGrowthProposal } from "@/lib/growth-client";

export async function POST(req: Request, ctx: RouteContext<"/api/growth/proposals/[id]/reject">) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({}));
  try {
    const result = await rejectGrowthProposal(Number(id), body.notes);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
