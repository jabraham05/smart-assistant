import { NextResponse } from "next/server";
import { getSessionMessages } from "@/lib/honcho-client";

export async function GET(
  _req: Request,
  ctx: RouteContext<"/api/sessions/[id]/messages">
) {
  const { id } = await ctx.params;
  const messages = await getSessionMessages(id);
  return NextResponse.json(messages);
}
