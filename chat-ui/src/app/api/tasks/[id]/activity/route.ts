import { NextResponse } from "next/server";
import { getTaskContextActivity } from "@/lib/event-bus-client";

// JSON twin of the server-rendered /tasks/[id] page, for the native app
// (which can't use a server component). Same data, same 404 semantics.
export async function GET(_req: Request, ctx: RouteContext<"/api/tasks/[id]/activity">) {
  const { id } = await ctx.params;
  try {
    const detail = await getTaskContextActivity(id);
    if (!detail) return NextResponse.json({ error: "task not found" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (e) {
    console.error(`failed to fetch activity for task ${id}:`, e);
    return NextResponse.json({ error: "failed to reach event-bus" }, { status: 502 });
  }
}
