import { NextRequest, NextResponse } from "next/server";
import { postEvent } from "@/lib/event-bus-client";

// Amy Lab's feedback form - lands in the same event-bus `behavior_feedback`
// stream chat-orchestrator's own self-reported feedback uses (see
// chat-orchestrator/src/events.ts), so both producers show up together
// wherever behavior_feedback events are read.
export async function POST(req: NextRequest) {
  let body: { category?: string; note?: string; sessionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.note || typeof body.note !== "string") {
    return NextResponse.json({ error: "note is required" }, { status: 400 });
  }

  try {
    await postEvent({
      source: "amy_lab",
      type: "behavior_feedback",
      payload: { category: body.category || "other", note: body.note },
      originSessionId: body.sessionId,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (e) {
    console.error("failed to submit feedback:", e);
    return NextResponse.json({ error: "failed to reach event-bus" }, { status: 502 });
  }
}
