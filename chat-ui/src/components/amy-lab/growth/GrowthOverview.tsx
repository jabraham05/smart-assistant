"use client";

import { useEffect, useState } from "react";
import type { GrowthExperiment, GrowthHistoryEntry, GrowthProposal, LearningPlan } from "@/lib/growth-client";
import { Card, CategoryBadge, EmptyRow, ErrorRow, formatDate } from "./shared";

// The measurement framing the user set explicitly: don't measure Growth
// by how much internal activity it generates (more opportunities, more
// skills) - measure it by whether real problems actually get fixed. This
// view leads with "what's waiting on you" and "what actually got fixed,"
// not a raw activity count.

export function GrowthOverview({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [proposals, setProposals] = useState<GrowthProposal[] | null>(null);
  const [plans, setPlans] = useState<LearningPlan[] | null>(null);
  const [experiments, setExperiments] = useState<GrowthExperiment[] | null>(null);
  const [history, setHistory] = useState<GrowthHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    Promise.all([
      fetch("/api/growth/proposals?status=proposed").then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch("/api/growth/learning-plans?status=active").then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch("/api/growth/experiments").then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch("/api/growth/history?limit=100").then((r) => (r.ok ? r.json() : Promise.reject())),
    ])
      .then(([p, lp, ex, h]) => {
        setProposals(p.proposals ?? []);
        setPlans(lp.learningPlans ?? []);
        setExperiments(ex.experiments ?? []);
        setHistory(h.history ?? []);
      })
      .catch(() => setError("Couldn't reach agent-service."));
  }, []);

  if (error) return <ErrorRow text={error} />;
  if (!proposals || !plans || !experiments || !history) return <EmptyRow text="Loading…" />;

  const failedExperiments = experiments.filter((e) => e.improved === false);
  const recentEvaluations = experiments.filter((e) => e.evaluation_id !== null).slice(0, 5);
  const consolidated = history.filter((h) => h.event_type === "consolidated").slice(0, 5);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card title="Pending approvals" count={proposals.length}>
        {proposals.length === 0 && <EmptyRow text="Nothing waiting on you right now." />}
        <ul className="space-y-1.5">
          {proposals.slice(0, 5).map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2 text-xs">
              <span className="flex items-center gap-1.5 truncate text-zinc-300">
                <CategoryBadge category={p.category} /> {p.opportunity_title ?? p.proposed_action}
              </span>
            </li>
          ))}
        </ul>
        {proposals.length > 0 && (
          <button onClick={() => onNavigate("review-queue")} className="mt-2 text-[11px] text-indigo-400 hover:text-indigo-300">
            Review all →
          </button>
        )}
      </Card>

      <Card title="Active learning plans" count={plans.length}>
        {plans.length === 0 && <EmptyRow text="Nothing in progress." />}
        <ul className="space-y-1.5">
          {plans.slice(0, 5).map((p) => (
            <li key={p.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-2 text-xs text-zinc-300">
              <div className="flex items-center gap-1.5">
                <CategoryBadge category={p.proposal_category ?? null} />
                <span className="truncate">{p.opportunity_title ?? p.goal}</span>
              </div>
              <p className="mt-1 text-[11px] text-zinc-500">
                {p.steps.filter((s) => s.status === "completed").length}/{p.steps.length} steps done
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Recent evaluations" count={recentEvaluations.length}>
        {recentEvaluations.length === 0 && <EmptyRow text="Nothing evaluated yet." />}
        <ul className="space-y-1.5">
          {recentEvaluations.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] p-2 text-xs">
              <span className="truncate text-zinc-300">{e.opportunity_title ?? e.description}</span>
              {e.improved !== null && (
                <span className={e.improved ? "text-emerald-400" : "text-rose-400"}>{e.improved ? "passed" : "failed"}</span>
              )}
            </li>
          ))}
        </ul>
        {experiments.length > 0 && (
          <button onClick={() => onNavigate("learning-plans")} className="mt-2 text-[11px] text-indigo-400 hover:text-indigo-300">
            See all experiments →
          </button>
        )}
      </Card>

      <Card title="Failed experiments" count={failedExperiments.length}>
        {failedExperiments.length === 0 && <EmptyRow text="None - nothing has failed evaluation." />}
        <ul className="space-y-1.5">
          {failedExperiments.slice(0, 5).map((e) => (
            <li key={e.id} className="rounded-lg border border-rose-500/20 bg-rose-500/[0.04] p-2 text-xs text-zinc-300">
              {e.opportunity_title ?? e.description}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Recently consolidated" count={consolidated.length}>
        {consolidated.length === 0 && <EmptyRow text="Nothing consolidated yet." />}
        <ul className="space-y-1.5">
          {consolidated.map((h) => (
            <li key={h.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-2 text-xs text-zinc-300">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 truncate">
                  <CategoryBadge category={h.proposal_category ?? null} />
                  {h.opportunity_title ?? `proposal #${h.proposal_id}`}
                </span>
                <span className="font-mono text-[10px] text-zinc-600">{formatDate(h.created_at)}</span>
              </div>
              {typeof h.detail?.destination === "string" && (
                <p className="mt-1 text-[11px] text-zinc-500">→ {h.detail.destination}</p>
              )}
            </li>
          ))}
        </ul>
        {history.length > 0 && (
          <button onClick={() => onNavigate("history")} className="mt-2 text-[11px] text-indigo-400 hover:text-indigo-300">
            Full history →
          </button>
        )}
      </Card>

      <Card title="How to read this">
        <p className="text-xs text-zinc-500">
          Growth isn&apos;t measured by how many opportunities or skills accumulate - watch for fewer repeated mistakes,
          better task completion, and improvements backed by a passing evaluation (not just raw activity). A lot of
          observed opportunities that never recur or never clear review is a healthy sign of selectivity, not a backlog
          problem.
        </p>
      </Card>
    </div>
  );
}
