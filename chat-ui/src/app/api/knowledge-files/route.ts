import { NextResponse } from "next/server";
import { getKnowledgeStoreFiles } from "@/lib/knowledge-engine-client";

export async function GET() {
  try {
    const files = await getKnowledgeStoreFiles();
    return NextResponse.json({ files });
  } catch (e) {
    console.error("failed to list knowledge store files:", e);
    return NextResponse.json({ error: "failed to reach knowledge-engine" }, { status: 502 });
  }
}
