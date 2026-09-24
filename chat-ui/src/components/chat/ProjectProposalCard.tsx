"use client";

import { useState } from "react";
import type { ProjectProposalCard as ProjectProposalCardData } from "@/types/chat";

type LocalStatus = "pending" | "approved" | "rejected";

// Same visual pattern as components/home/HomeDashboard.tsx's ApprovalRow
// (amber "needs approval" pill, title, rationale, Approve/Reject) - this is
// that same decision, now reachable inline in chat instead of requiring a
// trip to Home. Two render modes: a fresh proposal (buttons act on this
// project directly), or a dedup hit (buttons act on the EXISTING project
// project_propose matched, only shown while that project is itself still
// pending review) - see lib/project-card.ts for how `duplicate` gets set.
export function ProjectProposalCard({
  card,
  approve,
  reject,
}: {
  card: ProjectProposalCardData;
  approve: (id: number) => Promise<void>;
  reject: (id: number) => Promise<void>;
}) {
  const [status, setStatus] = useState<LocalStatus>(card.status === "proposed" ? "pending" : "approved");
  const [isActing, setIsActing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const act = async (action: "approve" | "reject") => {
    setIsActing(true);
    setError(undefined);
    try {
      await (action === "approve" ? approve(card.id) : reject(card.id));
      setStatus(action === "approve" ? "approved" : "rejected");
    } catch {
      setError(`Couldn't ${action} - try again.`);
    } finally {
      setIsActing(false);
    }
  };

  if (card.duplicate) {
    return (
      <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.02] p-2.5">
        <span className="rounded-full bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-zinc-400">
          already covered — project #{card.id}
        </span>
        <p className="mt-1 text-sm font-medium text-zinc-100">{card.title}</p>
        <p className="mt-0.5 text-xs text-zinc-500">{card.rationale}</p>
        {status === "pending" && card.status === "proposed" && (
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => act("approve")}
              disabled={isActing}
              className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
            >
              Approve
            </button>
            <button
              onClick={() => act("reject")}
              disabled={isActing}
              className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-40"
            >
              Reject
            </button>
          </div>
        )}
        {status !== "pending" && (
          <p className="mt-2 text-xs text-zinc-500">{status === "approved" ? "Approved." : "Rejected."}</p>
        )}
        {card.status !== "proposed" && status === "pending" && (
          <p className="mt-2 text-xs text-zinc-500">Status: {card.status}</p>
        )}
        {error && <p className="mt-1.5 text-xs text-rose-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-2.5">
      <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-wide text-amber-300">
        needs approval
      </span>
      <p className="mt-1 text-sm font-medium text-zinc-100">{card.title}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{card.rationale}</p>
      {status === "pending" ? (
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => act("approve")}
            disabled={isActing}
            className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
          >
            Approve
          </button>
          <button
            onClick={() => act("reject")}
            disabled={isActing}
            className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-40"
          >
            Reject
          </button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-zinc-500">{status === "approved" ? "Approved." : "Rejected."}</p>
      )}
      {error && <p className="mt-1.5 text-xs text-rose-400">{error}</p>}
    </div>
  );
}
