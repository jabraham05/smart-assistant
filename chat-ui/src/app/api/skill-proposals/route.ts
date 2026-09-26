import { NextRequest, NextResponse } from "next/server";
import { getSkillProposals } from "@/lib/skills-registry-client";

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  try {
    const proposals = await getSkillProposals(status);
    return NextResponse.json({ proposals });
  } catch (e) {
    console.error("failed to fetch skill proposals from skills-mcp:", e);
    return NextResponse.json({ error: "failed to reach skills-mcp" }, { status: 502 });
  }
}
