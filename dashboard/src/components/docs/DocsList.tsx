import Link from "next/link";
import { listDocs } from "@/lib/docs-source";

export async function DocsList({ activeSlug }: { activeSlug?: string }) {
  const docs = await listDocs();
  return (
    <nav className="flex w-56 shrink-0 flex-col gap-0.5">
      {docs.map((d) => (
        <Link
          key={d.slug}
          href={`/docs/${d.slug}`}
          className={`rounded-md px-2 py-1 text-sm ${
            d.slug === activeSlug ? "bg-black/10 font-medium dark:bg-white/10" : "text-black/70 hover:bg-black/5 dark:text-white/70 dark:hover:bg-white/5"
          }`}
        >
          {d.title}
        </Link>
      ))}
    </nav>
  );
}
