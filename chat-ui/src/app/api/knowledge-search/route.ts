import { NextRequest, NextResponse } from "next/server";
import { knowledgeSearch, type KnowledgeSearchRequest } from "@/lib/knowledge-engine-client";

export async function POST(req: NextRequest) {
  let body: KnowledgeSearchRequest;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  if (!body.query || typeof body.query !== "string") {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  try {
    const result = await knowledgeSearch(body);
    if ("error" in result) {
      return NextResponse.json(result, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: `knowledge-engine unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
}
