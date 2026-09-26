import { NextRequest, NextResponse } from "next/server";
import { getKnowledgeGraph } from "@/lib/graphiti-client";

export async function GET(req: NextRequest) {
  const groupId = req.nextUrl.searchParams.get("groupId") ?? undefined;
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Number(limitParam) : undefined;
  try {
    const graph = await getKnowledgeGraph(groupId, limit);
    return NextResponse.json(graph);
  } catch (e) {
    console.error("failed to fetch knowledge graph from graphiti-service:", e);
    return NextResponse.json({ error: "failed to reach graphiti-service" }, { status: 502 });
  }
}
