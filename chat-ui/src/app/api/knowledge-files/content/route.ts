import { NextRequest, NextResponse } from "next/server";
import { getKnowledgeStoreFileContent } from "@/lib/knowledge-engine-client";

export async function GET(req: NextRequest) {
  const path = req.nextUrl.searchParams.get("path");
  if (!path) return NextResponse.json({ error: "path is required" }, { status: 400 });
  try {
    const content = await getKnowledgeStoreFileContent(path);
    return NextResponse.json({ content });
  } catch (e) {
    console.error(`failed to read knowledge store file ${path}:`, e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed to reach knowledge-engine" }, { status: 502 });
  }
}
