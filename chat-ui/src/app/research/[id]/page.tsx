import { notFound } from "next/navigation";
import { getResearchDetail, type ResearchFinding } from "@/lib/knowledge-engine-client";

// Amy's own link target for "here's the full write-up" - inserted into her
// chat replies by research_task_status/research_task (see
// skills-mcp/src/tools/research-task-status.ts's documentUrl) so a
// concise chat answer can point somewhere neatly formatted for anyone who
// wants the full detail, rather than pasting every finding inline. Built
// because a live test showed the opposite failure: a wall-of-text chat
// reply with no consolidated place to actually read the research.
export default async function ResearchDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getResearchDetail(id);
  if (!detail) return notFound();

  const { session, findings } = detail;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Research write-up</p>
      <h1 className="mt-1 text-2xl font-semibold text-gray-900 dark:text-gray-100">{session.topic}</h1>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
        <StatusBadge status={session.status} />
        {session.domain && <span className="rounded bg-gray-100 px-2 py-0.5 dark:bg-gray-800">{session.domain}</span>}
        <span>{new Date(session.updated_at).toLocaleString()}</span>
      </div>

      {findings.length === 0 ? (
        <p className="mt-8 text-sm text-gray-500 dark:text-gray-400">
          {session.status === "running"
            ? "Still researching - check back shortly."
            : "No findings recorded for this topic yet."}
        </p>
      ) : (
        <ol className="mt-8 space-y-6">
          {findings.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </ol>
      )}
    </main>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    complete: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    running: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
    failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  };
  return (
    <span className={`rounded px-2 py-0.5 font-medium ${styles[status] ?? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"}`}>
      {status}
    </span>
  );
}

function FindingCard({ finding }: { finding: ResearchFinding }) {
  const confidenceStyles: Record<string, string> = {
    confirmed: "text-green-700 dark:text-green-400",
    contested: "text-amber-700 dark:text-amber-400",
  };
  return (
    <li className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
      <p className="text-sm leading-relaxed text-gray-800 dark:text-gray-200">{finding.claim}</p>
      <p className={`mt-2 text-xs font-medium uppercase tracking-wide ${confidenceStyles[finding.confidence] ?? "text-gray-500 dark:text-gray-400"}`}>
        {finding.confidence}
      </p>
      {finding.citations.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-gray-100 pt-3 dark:border-gray-800">
          {finding.citations.map((c, i) => (
            <li key={i} className="text-xs text-gray-500 dark:text-gray-400">
              {c.supports ? "" : "(disputed) "}
              {c.source_url ? (
                <a href={c.source_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
                  {c.source_title || c.source_url}
                </a>
              ) : (
                c.source_title
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
