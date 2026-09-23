import { notFound } from "next/navigation";
import { readDoc } from "@/lib/docs-source";
import { MarkdownContent } from "@/components/chat/MarkdownContent";

export const dynamic = "force-dynamic";

export default async function ArtifactDocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let content: string;
  try {
    content = await readDoc(slug);
  } catch {
    return notFound();
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <a href="/artifacts" className="text-xs text-blue-600 hover:underline dark:text-blue-400">
        ← Artifacts
      </a>
      <div className="mt-4">
        <MarkdownContent content={content} isUser={false} />
      </div>
    </main>
  );
}
