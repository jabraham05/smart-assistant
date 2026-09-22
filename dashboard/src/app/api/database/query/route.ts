import { NextRequest, NextResponse } from "next/server";
import { isDatabaseName } from "@/lib/pg-pools";
import { runReadOnlyQuery } from "@/lib/readonly-sql";

export async function POST(req: NextRequest) {
  let body: { database?: string; sql?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const { database, sql } = body;
  if (!database || !isDatabaseName(database)) {
    return NextResponse.json({ error: "database must be one of postgres|n8n|research|coding_tasks|events" }, { status: 400 });
  }
  if (!sql || typeof sql !== "string") {
    return NextResponse.json({ error: "sql is required" }, { status: 400 });
  }

  const start = performance.now();
  try {
    const result = await runReadOnlyQuery(database, sql);
    return NextResponse.json({
      fields: result.fields.map((f) => f.name),
      rows: result.rows,
      rowCount: result.rowCount,
      elapsedMs: Math.round(performance.now() - start),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
