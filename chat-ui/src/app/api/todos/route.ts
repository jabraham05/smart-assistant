import { NextRequest, NextResponse } from "next/server";
import { createTodo, updateTodo, listAllTaskContexts } from "@/lib/event-bus-client";

// Powers Amy Lab's Plans tab - full task-context list, optionally
// status-filtered, distinct from /api/home's capped openTasks summary.
export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  try {
    const taskContexts = await listAllTaskContexts(status);
    return NextResponse.json({ taskContexts });
  } catch (e) {
    console.error("failed to list task contexts:", e);
    return NextResponse.json({ error: "failed to reach event-bus" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  let body: { objective?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.objective || typeof body.objective !== "string") {
    return NextResponse.json({ error: "objective is required" }, { status: 400 });
  }

  try {
    const todo = await createTodo(body.objective);
    return NextResponse.json(todo, { status: 201 });
  } catch (e) {
    console.error("failed to create todo:", e);
    return NextResponse.json({ error: "failed to reach event-bus" }, { status: 502 });
  }
}

export async function PATCH(req: NextRequest) {
  let body: { id?: number; objective?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body.id || typeof body.id !== "number") {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  try {
    const todo = await updateTodo(body.id, { objective: body.objective, status: body.status });
    return NextResponse.json(todo);
  } catch (e) {
    console.error(`failed to update todo ${body.id}:`, e);
    return NextResponse.json({ error: "failed to reach event-bus" }, { status: 502 });
  }
}
