"use client";

import { useCallback, useEffect, useState } from "react";
import type { GrowthProposal, PersonaProposal } from "@/lib/growth-client";
import { ActionButton, APPROVAL_CONSEQUENCE, Card, CategoryBadge, EmptyRow, ErrorRow, StatusBadge, formatDate } from "./shared";

function PersonaProposalCard({ onChanged }: { onChanged: () => void }) {
  const [proposal, setProposal] = useState<PersonaProposal | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<string | undefined>();

  const refresh = useCallback(() => {
    fetch("/api/growth/persona-proposal")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then(setProposal)
      .catch(() => setError("Couldn't reach agent-service."));
  }, []);

  useEffect(() => refresh(), [refresh]);

  const act = async (action: "promote" | "dismiss") => {
    setResult(undefined);
    try {
      const res = await fetch(`/api/growth/persona-proposal/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!body.ok) {
        setResult(body.reason ?? "Action refused.");
        return;
      }
      setResult(action === "promote" ? "Promoted - now live." : "Dismissed.");
      refresh();
      onChanged();
    } catch {
      setResult("Couldn't reach agent-service.");
    }
  };

  if (error) return <ErrorRow text={error} />;
  if (!proposal) return <EmptyRow text="Loading…" />;
  if (!proposal.pending) return null;

  return (
    <li className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-amber-300">
          legacy persona proposal
        </span>
        <span className="font-mono text-[10px] text-zinc-600">{formatDate(proposal.proposed_at)}</span>
      </div>
      <p className="mt-1.5 text-xs font-medium text-zinc-200">Proposed reasoning</p>
      <p className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-400">{proposal.proposed_reason}</p>
      <p className="mt-1.5 text-xs font-medium text-zinc-200">Proposed text</p>
      <p className="mt-0.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-black/20 p-2 text-[11px] text-zinc-400">
        {proposal.proposed_system_prompt}
      </p>
      <p className="mt-1.5 text-[11px] text-zinc-600">
        Current persona is {proposal.system_prompt?.length ?? 0} chars; this proposal is{" "}
        {proposal.proposed_system_prompt?.length ?? 0} chars. Promotion is refused if the proposed text looks too
        short to be a real full replacement.
      </p>
      {result && <p className="mt-1.5 text-xs text-indigo-300">{result}</p>}
      <div className="mt-2 flex gap-2">
        <ActionButton label="Promote" tone="primary" onClick={() => act("promote")} />
        <ActionButton label="Dismiss" tone="danger" onClick={() => act("dismiss")} />
      </div>
    </li>
  );
}

function ProposalRow({ proposal, onDecided }: { proposal: GrowthProposal; onDecided: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState<string | undefined>();
  const isPending = proposal.status === "proposed";

  const act = async (action: "approve" | "reject") => {
    setResult(undefined);
    try {
      const res = await fetch(`/api/growth/proposals/${proposal.id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notes || undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setResult(body.error ?? "Action failed.");
        return;
      }
      if (action === "approve" && body.consolidation) {
        const c = body.consolidation as { destination?: string; evaluation?: { passed?: boolean }; regressedAny?: boolean };
        setResult(`Consolidated → ${c.destination ?? "?"}${c.evaluation ? ` (evaluation ${c.evaluation.passed ? "passed" : "flagged low-confidence"})` : ""}`);
      } else {
        setResult(action === "approve" ? "Approved." : "Rejected.");
      }
      onDecided();
    } catch {
      setResult("Couldn't reach agent-service.");
    }
  };

  return (
    <li className={`rounded-lg border p-2.5 ${isPending ? "border-amber-500/20 bg-amber-500/[0.04]" : "border-white/5 bg-white/[0.02]"}`}>
      <button onClick={() => setExpanded((v) => !v)} className="w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 truncate text-sm text-zinc-100">
            <CategoryBadge category={proposal.category} />
            {proposal.opportunity_title ?? proposal.proposed_action}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <span className="font-mono text-[9px] uppercase tracking-wide text-zinc-600">{proposal.approval_tier}</span>
            <StatusBadge status={proposal.status} />
          </div>
        </div>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2 border-t border-white/5 pt-2">
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wide text-zinc-600">Proposed action</p>
            <p className="text-xs text-zinc-300">{proposal.proposed_action}</p>
          </div>
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wide text-zinc-600">Rationale / evidence</p>
            <p className="text-xs text-zinc-400">{proposal.rationale}</p>
          </div>
          <div>
            <p className="text-[10px] font-mono uppercase tracking-wide text-zinc-600">What happens on approval</p>
            <p className="text-xs text-zinc-500">{APPROVAL_CONSEQUENCE[proposal.category] ?? "Consolidated."}</p>
          </div>
          {proposal.reviewer_notes && (
            <div>
              <p className="text-[10px] font-mono uppercase tracking-wide text-zinc-600">Reviewer notes</p>
              <p className="text-xs text-zinc-500">{proposal.reviewer_notes}</p>
            </div>
          )}
          {result && <p className="text-xs text-indigo-300">{result}</p>}
          {isPending && (
            <>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional note…"
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-xs text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-indigo-500/50"
              />
              <div className="flex gap-2">
                <ActionButton label="Approve" tone="primary" onClick={() => act("approve")} />
                <ActionButton label="Reject" tone="danger" onClick={() => act("reject")} />
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function GrowthReviewQueue() {
  const [proposals, setProposals] = useState<GrowthProposal[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [statusFilter, setStatusFilter] = useState<"proposed" | "approved" | "rejected">("proposed");

  const refresh = useCallback(() => {
    fetch(`/api/growth/proposals?status=${statusFilter}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setProposals(data.proposals ?? []))
      .catch(() => setError("Couldn't reach agent-service."));
  }, [statusFilter]);

  useEffect(() => refresh(), [refresh]);

  return (
    <div>
      {statusFilter === "proposed" && (
        <ul className="mb-3 space-y-1.5">
          <PersonaProposalCard onChanged={refresh} />
        </ul>
      )}

      <div className="mb-3 flex gap-1">
        {(["proposed", "approved", "rejected"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`rounded-lg px-2.5 py-1 text-xs capitalize transition-colors ${
              statusFilter === s ? "bg-white/10 font-medium text-zinc-200" : "text-zinc-600 hover:bg-white/5 hover:text-zinc-400"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {error && <ErrorRow text={error} />}
      {!error && proposals === null && <EmptyRow text="Loading…" />}

      <Card title="Growth proposals" count={proposals?.length ?? 0}>
        {proposals?.length === 0 && <EmptyRow text="Nothing here." />}
        <ul className="space-y-1.5">
          {proposals?.map((p) => (
            <ProposalRow key={p.id} proposal={p} onDecided={refresh} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
