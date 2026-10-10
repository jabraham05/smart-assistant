import { NextResponse } from "next/server";
import { dismissPersonaProposal } from "@/lib/growth-client";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  try {
    const result = await dismissPersonaProposal(body.reason);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
