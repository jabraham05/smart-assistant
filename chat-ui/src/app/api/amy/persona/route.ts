import { NextResponse } from "next/server";
import { getPersona } from "@/lib/chat-orchestrator-client";

export async function GET() {
  try {
    const systemPrompt = await getPersona();
    return NextResponse.json({ systemPrompt });
  } catch (e) {
    console.error("failed to fetch persona from chat-orchestrator:", e);
    return NextResponse.json({ error: "failed to reach chat-orchestrator" }, { status: 502 });
  }
}
