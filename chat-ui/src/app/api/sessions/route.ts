import { NextResponse } from "next/server";
import { listRealSessions } from "@/lib/honcho-client";

export async function GET() {
  const sessions = await listRealSessions();
  return NextResponse.json(sessions);
}
