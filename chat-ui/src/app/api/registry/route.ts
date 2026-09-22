import { NextResponse } from "next/server";
import { listRegisteredTools } from "@/lib/skills-registry-client";

export async function GET() {
  try {
    const tools = await listRegisteredTools();
    return NextResponse.json(tools);
  } catch (e) {
    console.error("failed to fetch tool registry from skills-mcp:", e);
    return NextResponse.json({ error: "failed to reach skills-mcp" }, { status: 502 });
  }
}
