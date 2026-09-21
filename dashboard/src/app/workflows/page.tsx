import { ExecutionsTable } from "@/components/workflows/ExecutionsTable";

// force-dynamic: reads N8N_PUBLIC_URL at request time (same reason as
// dashboard/src/app/chat/page.tsx - a runtime-only env var would otherwise
// get frozen in at the Docker build stage, before the container's env vars
// exist).
export const dynamic = "force-dynamic";

export default function WorkflowsPage() {
  const n8nUrl = process.env.N8N_PUBLIC_URL;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Workflows</h1>
        {n8nUrl && (
          <a
            href={n8nUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-black px-3 py-1.5 text-sm text-white dark:bg-white dark:text-black"
          >
            Open n8n Editor ↗
          </a>
        )}
      </div>
      <p className="mb-3 text-sm text-black/60 dark:text-white/60">
        n8n&apos;s editor sends <code>X-Frame-Options: SAMEORIGIN</code>, so it
        opens in a new tab instead of embedding here (confirmed live, not
        assumed). Recent executions and their per-node tool calls are below.
      </p>
      <ExecutionsTable />
    </div>
  );
}
