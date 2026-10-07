import { NextResponse } from "next/server";
import { getUserProfile } from "@/lib/chat-orchestrator-client";

export async function GET() {
  try {
    const profile = await getUserProfile();
    return NextResponse.json(profile);
  } catch (e) {
    console.error("failed to fetch user profile from chat-orchestrator:", e);
    return NextResponse.json({ error: "failed to reach chat-orchestrator" }, { status: 502 });
  }
}
