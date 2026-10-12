import { NextResponse } from "next/server";
import { listSkills } from "@/lib/growth-client";

// Read-only list of Amy's skills (for the native app's Amy Lab > Skills).
// New skills still arrive only through the approval pipelines.
export async function GET() {
  try {
    const skills = await listSkills();
    return NextResponse.json({ skills });
  } catch (e) {
    console.error("failed to fetch skills from agent-service:", e);
    return NextResponse.json({ error: "failed to reach agent-service" }, { status: 502 });
  }
}
