import { NextResponse } from "next/server";
import { getUserProfile } from "@/lib/profile-client";

export async function GET() {
  try {
    const profile = await getUserProfile();
    return NextResponse.json(profile);
  } catch (e) {
    console.error("failed to fetch user profile from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
