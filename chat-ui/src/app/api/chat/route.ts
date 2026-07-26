import { NextRequest, NextResponse } from "next/server";
import { streamFromN8n } from "@/lib/n8n-client";
import type { ChatRequest } from "@/types/chat";

export async function POST(req: NextRequest) {
  const body: ChatRequest = await req.json();

  if (!body.message || !body.sessionId) {
    return NextResponse.json(
      { error: "message and sessionId are required" },
      { status: 400 }
    );
  }

  const n8nRes = await streamFromN8n(body);

  return new Response(n8nRes.body, {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}
