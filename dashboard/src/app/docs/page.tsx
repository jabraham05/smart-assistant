import { DocsList } from "@/components/docs/DocsList";

// force-dynamic: DocsList reads the bind-mounted ./docs directory at
// request time. That mount doesn't exist during the Docker build stage, so
// without this Next.js would try to prerender the list at build time and
// fail outright (same class of gotcha as the runtime-env-var pages).
export const dynamic = "force-dynamic";

export default function DocsPage() {
  return (
    <div className="flex gap-6">
      <DocsList />
      <p className="text-sm text-black/50 dark:text-white/50">Pick a doc from the list.</p>
    </div>
  );
}
