import { notFound } from "next/navigation";
import { getResearchDetail, type ResearchFinding } from "@/lib/knowledge-engine-client";
import { MarkdownContent } from "@/components/chat/MarkdownContent";

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

  const { session, findings, documentMarkdown } = detail;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <a href="/artifacts" className="text-xs text-indigo-400 hover:text-indigo-300">
        ← Artifacts
      </a>
      <p className="mt-4 text-xs font-medium text-zinc-500">Research write-up</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-100">{session.topic}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <StatusBadge status={session.status} />
        {session.domain && <span className="rounded-full bg-white/5 px-2 py-0.5 text-zinc-400">{session.domain}</span>}
        <span className="font-mono text-[11px]">{new Date(session.updated_at).toLocaleString()}</span>
      </div>

      {documentMarkdown && (
        <div className="mt-8 rounded-xl border border-white/10 bg-zinc-900/40 p-5">
          <p className="mb-3 font-mono text-[10px] font-medium uppercase tracking-wide text-zinc-500">
            Consolidated knowledge
          </p>
          <MarkdownContent content={documentMarkdown} isUser={false} />
        </div>
      )}

      {findings.length === 0 ? (
        <p className="mt-8 text-sm text-zinc-500">
          {session.status === "running" ? "Still researching - check back shortly." : "No findings recorded for this topic yet."}
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
    complete: "bg-emerald-500/10 text-emerald-300",
    running: "bg-indigo-500/10 text-indigo-300",
    failed: "bg-rose-500/10 text-rose-300",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 font-medium ${styles[status] ?? "bg-white/5 text-zinc-400"}`}>{status}</span>
  );
}

function FindingCard({ finding }: { finding: ResearchFinding }) {
  const confidenceStyles: Record<string, string> = {
    confirmed: "text-emerald-400",
    contested: "text-amber-400",
  };
  return (
    <li className="rounded-xl border border-white/10 bg-zinc-900/40 p-4">
      <p className="text-sm leading-relaxed text-zinc-200">{finding.claim}</p>
      <p className={`mt-2 font-mono text-xs font-medium uppercase tracking-wide ${confidenceStyles[finding.confidence] ?? "text-zinc-500"}`}>
        {finding.confidence}
      </p>
      {finding.citations.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-white/10 pt-3">
          {finding.citations.map((c, i) => (
            <li key={i} className="text-xs text-zinc-500">
              {c.supports ? "" : "(disputed) "}
              {c.source_url ? (
                <a href={c.source_url} target="_blank" rel="noreferrer" className="text-indigo-400 hover:text-indigo-300 hover:underline">
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
