import { NextResponse } from "next/server";
import { getPersonaSnapshot } from "@/lib/chat-orchestrator-client";

export async function GET() {
  try {
    const snapshot = await getPersonaSnapshot();
    return NextResponse.json(snapshot);
  } catch (e) {
    console.error("failed to fetch persona snapshot from chat-orchestrator:", e);
    return NextResponse.json({ error: "failed to reach chat-orchestrator" }, { status: 502 });
  }
}
