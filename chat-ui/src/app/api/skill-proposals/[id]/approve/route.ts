import { NextResponse } from "next/server";
import { reviewSkillProposal } from "@/lib/skills-registry-client";

export async function POST(_req: Request, ctx: RouteContext<"/api/skill-proposals/[id]/approve">) {
  const { id } = await ctx.params;
  try {
    const proposal = await reviewSkillProposal(Number(id), "approve");
    return NextResponse.json(proposal);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
