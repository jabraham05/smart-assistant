import { NextRequest, NextResponse } from "next/server";
import { listMemoryEntries, searchMemoryEntries } from "@/lib/memory-engine-client";

// GET: browse (default view). POST: relevance-ranked search, same
// multi-verb-single-file convention as /api/todos/route.ts.
export async function GET(req: NextRequest) {
  const limit = Number(req.nextUrl.searchParams.get("limit")) || undefined;
  const offset = Number(req.nextUrl.searchParams.get("offset")) || undefined;
  const domain = req.nextUrl.searchParams.get("domain") ?? undefined;

  try {
    const entries = await listMemoryEntries({ limit, offset, domain });
    return NextResponse.json({ entries });
  } catch (e) {
    console.error("failed to list memory entries:", e);
    return NextResponse.json({ error: "failed to reach memory-engine" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  let body: { query?: string; domain?: string; topK?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.query || typeof body.query !== "string") {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }

  try {
    const results = await searchMemoryEntries(body.query, { domain: body.domain, topK: body.topK });
    return NextResponse.json({ results });
  } catch (e) {
    console.error("failed to search memory entries:", e);
    return NextResponse.json({ error: "failed to reach memory-engine" }, { status: 502 });
  }
}
