"use client";

import { useEffect, useState } from "react";
import type { GrowthExperiment, LearningPlan } from "@/lib/growth-client";
import { Card, CategoryBadge, EmptyRow, ErrorRow, StatusBadge, formatDate } from "./shared";

function StepList({ plan }: { plan: LearningPlan }) {
  return (
    <ul className="mt-1.5 space-y-0.5">
      {plan.steps.map((s, i) => (
        <li key={i} className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <span
            className={
              s.status === "completed" ? "text-emerald-400" : s.status === "failed" ? "text-rose-400" : "text-zinc-600"
            }
          >
            {s.status === "completed" ? "✓" : s.status === "failed" ? "✗" : "○"}
          </span>
          {s.description}
        </li>
      ))}
    </ul>
  );
}

function ExperimentRow({ experiment }: { experiment: GrowthExperiment }) {
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 truncate text-sm text-zinc-100">
          <CategoryBadge category={experiment.proposal_category ?? null} />
          {experiment.opportunity_title ?? experiment.description}
        </span>
        <StatusBadge status={experiment.status} />
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">{experiment.description}</p>
      {experiment.metric && (
        <div className="mt-1.5 flex items-center gap-3 text-[11px]">
          <span className="font-mono text-zinc-600">{experiment.metric}</span>
          {experiment.candidate_score !== null && (
            <span className="font-mono text-zinc-400">
              {experiment.baseline_score !== null ? `${experiment.baseline_score} → ` : ""}
              {experiment.candidate_score}
            </span>
          )}
          {experiment.improved !== null && (
            <span className={experiment.improved ? "text-emerald-400" : "text-rose-400"}>
              {experiment.improved ? "improved" : "did not improve"}
            </span>
          )}
          <span className="font-mono text-zinc-700">{formatDate(experiment.evaluated_at)}</span>
        </div>
      )}
      {experiment.evaluation_notes && <p className="mt-1 text-[11px] text-zinc-600">{experiment.evaluation_notes}</p>}
    </li>
  );
}

export function GrowthLearningPlans() {
  const [plans, setPlans] = useState<LearningPlan[] | null>(null);
  const [experiments, setExperiments] = useState<GrowthExperiment[] | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    Promise.all([
      fetch("/api/growth/learning-plans").then((r) => (r.ok ? r.json() : Promise.reject())),
      fetch("/api/growth/experiments").then((r) => (r.ok ? r.json() : Promise.reject())),
    ])
      .then(([lp, ex]) => {
        setPlans(lp.learningPlans ?? []);
        setExperiments(ex.experiments ?? []);
      })
      .catch(() => setError("Couldn't reach agent-service."));
  }, []);

  if (error) return <ErrorRow text={error} />;
  if (!plans || !experiments) return <EmptyRow text="Loading…" />;

  return (
    <div className="space-y-4">
      <Card title="Learning plans" count={plans.length}>
        {plans.length === 0 && <EmptyRow text="Nothing yet - a plan is created automatically when a proposal is approved." />}
        <ul className="space-y-2">
          {plans.map((p) => (
            <li key={p.id} className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 truncate text-sm text-zinc-100">
                  <CategoryBadge category={p.proposal_category ?? null} />
                  {p.opportunity_title ?? p.goal}
                </span>
                <StatusBadge status={p.status} />
              </div>
              <StepList plan={p} />
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Experiments & evaluations" count={experiments.length}>
        {experiments.length === 0 && <EmptyRow text="Nothing evaluated yet." />}
        <ul className="space-y-1.5">
          {experiments.map((e) => (
            <ExperimentRow key={e.id} experiment={e} />
          ))}
        </ul>
      </Card>
    </div>
  );
}
