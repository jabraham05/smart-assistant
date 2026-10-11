// Shared bits across the five Growth sub-tabs - kept here rather than
// duplicated five times, but deliberately small: this isn't a general
// design-system file, just what these specific views repeat.

export function Card({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
        {count !== undefined && (
          <span className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[11px] text-zinc-500">{count}</span>
        )}
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

export function EmptyRow({ text }: { text: string }) {
  return <p className="px-1 py-1 text-xs text-zinc-600">{text}</p>;
}

export function ErrorRow({ text }: { text: string }) {
  return <p className="px-1 py-1 text-xs text-rose-400">{text}</p>;
}

const CATEGORY_COLORS: Record<string, string> = {
  knowledge: "bg-sky-500/10 text-sky-300",
  skill: "bg-violet-500/10 text-violet-300",
  behavior: "bg-amber-500/10 text-amber-300",
  tool: "bg-fuchsia-500/10 text-fuchsia-300",
};

export function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null;
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${
        CATEGORY_COLORS[category] ?? "bg-white/5 text-zinc-400"
      }`}
    >
      {category}
    </span>
  );
}

const STATUS_COLORS: Record<string, string> = {
  observed: "bg-white/5 text-zinc-500",
  scored: "bg-indigo-500/10 text-indigo-300",
  proposed: "bg-amber-500/10 text-amber-300",
  approved: "bg-emerald-500/10 text-emerald-300",
  rejected: "bg-rose-500/10 text-rose-300",
  dormant: "bg-white/5 text-zinc-600",
  active: "bg-indigo-500/10 text-indigo-300",
  complete: "bg-emerald-500/10 text-emerald-300",
  abandoned: "bg-rose-500/10 text-rose-300",
  pending: "bg-white/5 text-zinc-500",
  running: "bg-indigo-500/10 text-indigo-300",
  failed: "bg-rose-500/10 text-rose-300",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${
        STATUS_COLORS[status] ?? "bg-white/5 text-zinc-400"
      }`}
    >
      {status}
    </span>
  );
}

export function ScoreTag({ score }: { score: number | null }) {
  if (score === null) return null;
  const tone = score >= 8 ? "text-emerald-300" : score >= 4 ? "text-amber-300" : "text-zinc-500";
  return <span className={`font-mono text-[11px] ${tone}`}>score {score.toFixed(1)}</span>;
}

// Renders a unified diff (as produced by Python's difflib.unified_diff)
// with +/- line coloring - used wherever a Growth proposal's real
// current-vs-proposed candidate text needs to be shown before approval.
export function DiffView({ diff }: { diff: string[] }) {
  if (!diff.length) return null;
  return (
    <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/20 p-2 text-[11px] leading-snug">
      {diff.map((line, i) => {
        const tone =
          line.startsWith("+") && !line.startsWith("+++")
            ? "text-emerald-400"
            : line.startsWith("-") && !line.startsWith("---")
              ? "text-rose-400"
              : line.startsWith("@@")
                ? "text-indigo-400"
                : "text-zinc-500";
        return (
          <div key={i} className={tone}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function formatDate(iso: string | null | undefined) {
  if (!iso) return "";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ActionButton({
  label,
  onClick,
  tone = "default",
  disabled,
}: {
  label: string;
  onClick: () => void;
  tone?: "default" | "primary" | "danger";
  disabled?: boolean;
}) {
  const toneClass =
    tone === "primary"
      ? "bg-indigo-600 text-white hover:bg-indigo-500"
      : tone === "danger"
        ? "border border-rose-500/30 text-rose-300 hover:bg-rose-500/10"
        : "border border-white/10 text-zinc-300 hover:bg-white/5";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${toneClass}`}
    >
      {label}
    </button>
  );
}

// What approving a proposal in this category actually does - shown before
// the user commits, since the review queue can't show a literal preview
// of the generated candidate text (persona edits/skill instructions are
// only generated at consolidation time, not stored ahead of approval).
export const APPROVAL_CONSEQUENCE: Record<string, string> = {
  knowledge: "Recorded as a durable learning in Amy's knowledge base immediately - no further review needed.",
  skill: "A draft skill is written and evaluated against the evidence that produced it. A low-confidence draft is still written, but flagged with a warning instead of looking as sound as a strong one.",
  tool: "Queued into the existing tool-idea review list (same place skill_propose tool ideas go) - still needs separate review there before anything is built.",
  behavior: "A candidate persona edit is generated and checked against golden-transcript regression tests, then written to the pending persona-proposal slot - it still requires a separate, explicit promotion step before it affects Amy's live behavior.",
};
