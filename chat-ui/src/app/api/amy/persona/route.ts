import { NextResponse } from "next/server";
import { getPersona } from "@/lib/profile-client";

export async function GET() {
  try {
    const systemPrompt = await getPersona();
    return NextResponse.json({ systemPrompt });
  } catch (e) {
    console.error("failed to fetch persona from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
