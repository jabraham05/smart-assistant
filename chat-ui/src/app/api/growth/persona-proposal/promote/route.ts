import { NextResponse } from "next/server";
import { promotePersonaProposal } from "@/lib/growth-client";

export async function POST() {
  try {
    const result = await promotePersonaProposal();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
