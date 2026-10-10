import { NextResponse } from "next/server";
import { promoteOpportunity } from "@/lib/growth-client";

export async function POST(_req: Request, ctx: RouteContext<"/api/growth/opportunities/[id]/promote">) {
  const { id } = await ctx.params;
  try {
    const result = await promoteOpportunity(Number(id));
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
