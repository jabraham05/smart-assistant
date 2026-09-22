import { NextRequest, NextResponse } from "next/server";
import { getProjects } from "@/lib/knowledge-engine-client";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  try {
    const projects = await getProjects(status);
    return NextResponse.json({ projects });
  } catch (e) {
    console.error("failed to fetch projects from knowledge-engine:", e);
    return NextResponse.json({ error: "failed to reach knowledge-engine" }, { status: 502 });
  }
}
