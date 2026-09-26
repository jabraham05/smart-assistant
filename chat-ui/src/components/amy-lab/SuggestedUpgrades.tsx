"use client";

import { useEffect, useState } from "react";
import { useSkillProposals } from "@/hooks/useSkillProposals";
import type { SkillProposal } from "@/lib/skills-registry-client";
import type { Project } from "@/lib/knowledge-engine-client";
import type { EventBusEvent } from "@/types/chat";

function SectionCard({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900/40">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
        <span className="rounded-full bg-white/5 px-2 py-0.5 font-mono text-[11px] text-zinc-500">{count}</span>
      </div>
      <div className="p-3">{children}</div>
    </section>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="px-1 py-1 text-xs text-zinc-600">{text}</p>;
}

function SkillProposalRow({
  proposal,
  onApprove,
  onReject,
}: {
  proposal: SkillProposal;
  onApprove?: () => void;
  onReject?: () => void;
}) {
  const isPending = proposal.status === "proposed";
  return (
    <li
      className={`rounded-lg border p-2.5 ${
        isPending ? "border-amber-500/20 bg-amber-500/[0.04]" : "border-white/5 bg-white/[0.02]"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full bg-white/5 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-zinc-500">
          {proposal.kind}
        </span>
        {!isPending && (
          <span
            className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide ${
              proposal.status === "approved" ? "bg-emerald-500/10 text-emerald-300" : "bg-rose-500/10 text-rose-300"
            }`}
          >
            {proposal.status}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm font-medium text-zinc-100">{proposal.name}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{proposal.description}</p>
      {isPending && onApprove && onReject && (
        <div className="mt-2 flex gap-2">
          <button
            onClick={onApprove}
            className="rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-indigo-500"
          >
            Approve
          </button>
          <button
            onClick={onReject}
            className="rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-white/5"
          >
            Reject
          </button>
        </div>
      )}
    </li>
  );
}

function BehaviorFeedbackRow({ event }: { event: EventBusEvent }) {
  const category = String(event.payload.category ?? "other");
  const note = String(event.payload.note ?? "");
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="rounded-full bg-violet-500/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-violet-300">
          {category}
        </span>
        <span className="font-mono text-[10px] text-zinc-600">{new Date(event.occurred_at).toLocaleDateString()}</span>
      </div>
      <p className="mt-1 text-xs text-zinc-400">{note}</p>
    </li>
  );
}

function ProjectProposalRow({ project }: { project: Project }) {
  return (
    <li className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <p className="text-sm text-zinc-100">{project.title}</p>
      <p className="mt-0.5 text-xs text-zinc-500">{project.rationale}</p>
    </li>
  );
}

export function SuggestedUpgrades() {
  const { proposals, isLoading: proposalsLoading, error: proposalsError, actionError, refresh, approve, reject } = useSkillProposals();
  const [feedback, setFeedback] = useState<EventBusEvent[] | null>(null);
  const [feedbackError, setFeedbackError] = useState<string | undefined>();
  const [projectProposals, setProjectProposals] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | undefined>();

  useEffect(() => {
    refresh();
    fetch("/api/events?type=behavior_feedback&limit=50")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((events) => setFeedback(events))
      .catch(() => setFeedbackError("Couldn't reach event-bus."));
    fetch("/api/projects?status=proposed")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data) => setProjectProposals(data.projects ?? []))
      .catch(() => setProjectsError("Couldn't reach knowledge-engine."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingSkills = proposals.filter((p) => p.status === "proposed");
  const reviewedSkills = proposals.filter((p) => p.status !== "proposed");

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <SectionCard title="Proposed skills" count={pendingSkills.length}>
        {actionError && <p className="mb-2 text-xs text-rose-400">{actionError}</p>}
        {proposalsError && <p className="text-xs text-rose-400">{proposalsError}</p>}
        {!proposalsLoading && !proposalsError && pendingSkills.length === 0 && (
          <EmptyRow text="Nothing awaiting review." />
        )}
        <ul className="space-y-1.5">
          {pendingSkills.map((p) => (
            <SkillProposalRow key={p.id} proposal={p} onApprove={() => approve(p.id)} onReject={() => reject(p.id)} />
          ))}
        </ul>
        {reviewedSkills.length > 0 && (
          <>
            <p className="mb-1.5 mt-3 font-mono text-[10px] uppercase tracking-wide text-zinc-600">Reviewed</p>
            <ul className="space-y-1.5">
              {reviewedSkills.map((p) => (
                <SkillProposalRow key={p.id} proposal={p} />
              ))}
            </ul>
          </>
        )}
      </SectionCard>

      <SectionCard title="Project proposals" count={projectProposals?.length ?? 0}>
        {projectsError && <p className="text-xs text-rose-400">{projectsError}</p>}
        {!projectsError && projectProposals === null && <EmptyRow text="Loading…" />}
        {!projectsError && projectProposals?.length === 0 && <EmptyRow text="Nothing awaiting approval." />}
        <ul className="space-y-1.5">
          {projectProposals?.map((p) => (
            <ProjectProposalRow key={p.id} project={p} />
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="Behavior feedback" count={feedback?.length ?? 0}>
        {feedbackError && <p className="text-xs text-rose-400">{feedbackError}</p>}
        {!feedbackError && feedback === null && <EmptyRow text="Loading…" />}
        {!feedbackError && feedback?.length === 0 && <EmptyRow text="No feedback recorded yet." />}
        <ul className="space-y-1.5">
          {feedback?.map((e) => (
            <BehaviorFeedbackRow key={e.id} event={e} />
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="Model & tool-usage evaluation (DSPy)" count={0}>
        <EmptyRow text="Not yet instrumented - no evaluation pipeline exists yet." />
      </SectionCard>
    </div>
  );
}
