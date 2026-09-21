import { NextResponse } from "next/server";
import { readDoc } from "@/lib/docs-source";

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    const content = await readDoc(slug);
    return NextResponse.json({ content });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 404 });
  }
}
