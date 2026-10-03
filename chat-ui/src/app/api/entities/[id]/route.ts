import { NextResponse } from "next/server";
import { getEntityDetail } from "@/lib/knowledge-engine-client";

export async function GET(_req: Request, ctx: RouteContext<"/api/entities/[id]">) {
  const { id } = await ctx.params;
  try {
    const entity = await getEntityDetail(id);
    if (!entity) return NextResponse.json({ error: `entity ${id} not found` }, { status: 404 });
    return NextResponse.json(entity);
  } catch (e) {
    console.error(`failed to fetch entity ${id} from knowledge-engine:`, e);
    return NextResponse.json({ error: "failed to reach knowledge-engine" }, { status: 502 });
  }
}
