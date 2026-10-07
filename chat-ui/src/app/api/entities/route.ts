import { NextRequest, NextResponse } from "next/server";
import { getEntities } from "@/lib/knowledge-engine-client";

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type") ?? undefined;
  try {
    const entities = await getEntities(type);
    return NextResponse.json({ entities });
  } catch (e) {
    console.error("failed to fetch entities from knowledge-engine:", e);
    return NextResponse.json({ error: "failed to reach knowledge-engine" }, { status: 502 });
  }
}
