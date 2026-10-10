import { NextResponse } from "next/server";
import { getPersonaProposal } from "@/lib/growth-client";

export async function GET() {
  try {
    const proposal = await getPersonaProposal();
    return NextResponse.json(proposal);
  } catch (e) {
    console.error("failed to fetch persona proposal from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
