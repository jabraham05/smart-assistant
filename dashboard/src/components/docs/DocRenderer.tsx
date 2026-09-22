"use client";

import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";

export function DocRenderer({ slug }: { slug: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setContent(null);
    setError(null);
    fetch(`/api/docs/${slug}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setContent(data.content);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [slug]);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (content === null) return <p className="text-sm text-black/50 dark:text-white/50">Loading...</p>;

  // No @tailwindcss/typography plugin installed (not used elsewhere in this
  // repo, and not worth a new dependency just for this) - markdown renders
  // with plain browser default element styling, which is legible enough
  // for an internal ops tool.
  return (
    <article className="max-w-3xl leading-relaxed [&_code]:rounded [&_code]:bg-black/[.05] [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sm dark:[&_code]:bg-white/10 [&_h1]:mb-3 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-4 [&_h3]:font-medium [&_p]:mb-3 [&_pre]:mb-3 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-black/[.05] [&_pre]:p-3 [&_pre]:text-sm dark:[&_pre]:bg-white/[.05] [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown>{content}</ReactMarkdown>
    </article>
  );
}
