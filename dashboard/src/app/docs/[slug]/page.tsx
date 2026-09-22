import { DocsList } from "@/components/docs/DocsList";
import { DocRenderer } from "@/components/docs/DocRenderer";

// See dashboard/src/app/docs/page.tsx for why this is needed.
export const dynamic = "force-dynamic";

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return (
    <div className="flex gap-6">
      <DocsList activeSlug={slug} />
      <DocRenderer slug={slug} />
    </div>
  );
}
