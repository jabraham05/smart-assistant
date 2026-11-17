import { NextRequest, NextResponse } from "next/server";
import { getUserProfile } from "@/lib/profile-client";
import { DEFAULT_USER_ID } from "@/lib/identity";

export async function GET(req: NextRequest) {
  try {
    const userId = req.nextUrl.searchParams.get("userId") || DEFAULT_USER_ID;
    const profile = await getUserProfile(userId);
    return NextResponse.json(profile);
  } catch (e) {
    console.error("failed to fetch user profile from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
