import { notFound } from "next/navigation";
import Link from "next/link";
import { getTaskContextActivity } from "@/lib/event-bus-client";
import { ActivityFeedItem } from "@/components/activity/ActivityFeedItem";

// The task-scoped detail view linked from Home's Open Tasks card
// ("Details") - the full, granular activity trail for one task_context:
// log notes + step transitions + any tagged events, unlike Home's own
// feed which only shows a coarse create/status-change summary.
export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getTaskContextActivity(id);
  if (!detail) return notFound();

  const { taskContext, items } = detail;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/" className="text-xs text-indigo-400 hover:text-indigo-300">
        ← Home
      </Link>
      <p className="mt-4 text-xs font-medium text-zinc-500">Task</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-100">{taskContext.objective}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <StatusBadge status={taskContext.status} />
        {taskContext.domain && <span className="rounded-full bg-white/5 px-2 py-0.5 text-zinc-400">{taskContext.domain}</span>}
        <span className="font-mono text-[11px]">{new Date(taskContext.updated_at).toLocaleString()}</span>
      </div>
      {taskContext.next_action && taskContext.status !== "done" && (
        <p className="mt-3 text-sm text-zinc-300">Next: {taskContext.next_action}</p>
      )}

      {/* What Amy actually knows about this task, kept current via
          task_context_manage's action='update' - read-only here since Amy,
          not the user, is meant to maintain it (see skills-mcp's tool
          description); this is purely a window into that, not an editor. */}
      <DetailList label="Facts" items={taskContext.facts} />
      <DetailList label="Assumptions" items={taskContext.assumptions} />
      <DetailList label="Open questions" items={taskContext.unknowns} />

      <p className="mt-8 mb-3 font-mono text-[10px] font-medium uppercase tracking-wide text-zinc-500">Activity</p>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500">Nothing recorded for this task yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <ActivityFeedItem key={item.id} label={item.kind} summary={item.summary} occurredAt={item.occurredAt} />
          ))}
        </ul>
      )}
    </main>
  );
}

function DetailList({ label, items }: { label: string; items: string[] | null | undefined }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-4">
      <p className="mb-1.5 font-mono text-[10px] font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <ul className="list-inside list-disc space-y-0.5 text-sm text-zinc-300">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: "bg-indigo-500/10 text-indigo-300",
    waiting_for_user: "bg-amber-500/10 text-amber-300",
    done: "bg-emerald-500/10 text-emerald-300",
    abandoned: "bg-rose-500/10 text-rose-300",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 font-medium ${styles[status] ?? "bg-white/5 text-zinc-400"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
