import { NextRequest, NextResponse } from "next/server";
import { updateGoal } from "@/lib/event-bus-client";

export async function PATCH(req: NextRequest) {
  let body: { id?: number; title?: string; description?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.id || typeof body.id !== "number") {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const goal = await updateGoal(body.id, { title: body.title, description: body.description, status: body.status });
    return NextResponse.json(goal);
  } catch (e) {
    console.error(`failed to update goal ${body.id}:`, e);
    return NextResponse.json({ error: "failed to reach event-bus" }, { status: 502 });
  }
}
