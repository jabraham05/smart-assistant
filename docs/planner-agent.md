# Planner agent

Planner is a reusable, invoked planning capability with domain-specific
profiles. It is not an autonomous workflow owner and does not execute plans.

## Ownership

- **Growth** decides whether a knowledge opportunity deserves research. An
  explicit user request is direct authorization to enter Growth's planning
  path; ambient interests still go through Growth's recurrence/value scoring.
- **Planner, research profile** scopes an approved opportunity into a topic,
  ordered steps, assumptions, and questions. It may use saved knowledge and
  bounded web search to shape the brief. It does not approve/reject the
  opportunity or claim to have completed research.
- **Research agent** receives the approved brief, investigates it, checks
  sources, and creates or updates the durable knowledge document.
- **Coding Orchestrator** decides when to plan a code task. Planner's coding
  profile produces implementation steps, assumptions, test command, and (for
  from-scratch work) a starter template. The Coder, Tester, and Reviewer
  stages remain responsible for execution and verification.

## Shared contract

Growth and Coding Orchestrator currently run in different languages. To avoid
a new service, each has a thin runtime adapter that follows this common
contract; domain-specific fields are kept in each profile's payload.

Common plan fields:

- `summary`: short description of the intended outcome.
- `steps`: ordered, actionable planning steps.
- `assumptions`: explicit assumptions or unresolved inputs.

Approval and execution status belong to the owning workflow and are tracked
outside the Planner output.

The research profile adds `topic` and `questions`. The coding profile adds
`testCommand` and `template`. Inputs and outputs are structured JSON, with
source passages treated as untrusted data. The Planner's tools are read-only
and scoped by profile. Keep it for genuinely multi-step work; quick lookups
and simple actions bypass it.

## Knowledge lookup versus research

Amy's chat-facing `knowledge_lookup` searches saved reference/research
documents and the live web concurrently for an immediate answer. Personal
conversation recall remains `memory_recall`. A lookup does not create a
document. Only Growth can promote a research opportunity into a planned task;
the Research agent performs the work and persists the resulting document.
