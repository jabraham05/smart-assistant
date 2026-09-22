import { NextRequest, NextResponse } from "next/server";
import { getContainerLogs, COMPOSE_SERVICES } from "@/lib/docker-client";

export async function GET(req: NextRequest, { params }: { params: Promise<{ service: string }> }) {
  const { service } = await params;
  if (!(COMPOSE_SERVICES as readonly string[]).includes(service)) {
    return NextResponse.json({ error: `unknown service "${service}"` }, { status: 400 });
  }
  const tail = Number(req.nextUrl.searchParams.get("tail") ?? "200");

  try {
    const logs = await getContainerLogs(service, tail);
    return NextResponse.json({ logs });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
