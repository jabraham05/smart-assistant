# Amy knowledge acquisition and research flow

## Purpose

Give Amy a reliable immediate lookup path and a separate, reviewable path for durable research. Keep personal conversation memory in memory-engine and sourced reference knowledge and research in knowledge-engine.

## Ownership

| Component | Owns | Does not own |
| --- | --- | --- |
| Amy conversation agent | Answering this turn, deciding when an immediate lookup is needed, and submitting explicit deep-research requests | Choosing autonomous research priorities or doing durable research itself |
| `knowledge_lookup` | Checking Amy's saved knowledge and the live web concurrently, then returning their results with provenance | Personal conversation recall; Growth prioritization; long-form research |
| Growth | Recording and scoring ambient knowledge gaps; deciding which opportunities merit durable research; accepting explicit user research requests as authorized candidates | Searching for and writing the final research result |
| Planner | Reusable, on-demand planning capability. For Growth, scopes an approved research opportunity into a bounded brief; for Coding, turns an approved request into implementation steps | Acting as an autonomous agent, promoting Growth observations, or executing the plan |
| Research agent / knowledge engine | Executing the research brief, saving sourced findings and documents, and exposing status | Deciding whether ambient gaps merit research |
| `memory_recall` | Retrieving personal facts and context from prior conversations | Manuals, reference documents, or public factual lookup |

Planner is a reusable capability invoked by its owning workflow, not a separate service or independent always-on agent. Growth remains the decision-maker for ambient opportunities. An explicit request for deep research is submitted to Growth as authorized work; Growth records and promotes it, then Planner scopes it and Research executes it.

## User-facing flows

### Amy knows the answer from the current context

Amy answers from reliable injected knowledge or conversation context, citing the relevant source when one exists. Personal facts from prior conversations come from memory context or `memory_recall`.

### Amy needs an immediate factual lookup

1. Amy calls `knowledge_lookup` once.
2. The tool runs saved-knowledge search and web search concurrently.
3. Each result set retains its own sources, URLs, titles, and errors. A failure on one side does not discard successful results from the other.
4. Amy answers from the returned evidence, distinguishes old saved material from current web results, and says when neither side supports an answer. A missing saved match alone is not evidence that the web has no answer.

The classifier maps both `web` and `knowledge` intent to this tool. Legacy `web_search` and `knowledge_search` remain registered for compatibility and specialized callers; Amy's ordinary chat lookup uses the combined tool.

### Amy has partial or stale information

Amy uses `knowledge_lookup` to check both sources. She identifies any stale saved result by its provenance/date, prefers current sources for time-sensitive claims, and communicates gaps rather than filling them with unsupported specifics. The live grounding check and retry path guard specific claims against evidence available in the turn, including injected context and tool results.

### User explicitly asks for durable research

1. Amy calls `growth_research_request` with the requested topic.
2. Growth records the request as an explicit, authorized research opportunity.
3. Growth promotes it through its normal lifecycle and invokes Planner to scope questions and check existing coverage.
4. Growth hands the bounded brief to Research; Research searches, cross-checks, and persists cited findings in knowledge-engine.
5. Amy can report task status through the existing status path. Later lookups can retrieve the saved result via `knowledge_lookup`.

The conversation agent does not bypass Growth with a direct `research_task` execution. That legacy tool may remain registered for compatibility but is not exposed by the ordinary chat classifier.

### Growth notices an ambient knowledge gap

1. A one-off gap may be recorded as an observation; it does not cause Amy to launch research from the live turn.
2. Growth aggregates and scores observations, considering reuse, recurrence, uncertainty, existing coverage, freshness, and effort.
3. If Growth promotes the opportunity, Planner checks saved knowledge and the web and returns a bounded research brief.
4. Growth queues the brief for Research. The queue is linked to the Growth opportunity and reclaims work left in `researching` after the stale-claim interval.
5. Research persists findings and citations; future answers use the saved result.

## Planner contract

Planner is shared as a documented input/output contract with runtime-specific adapters, since Growth currently runs in Python and Coding in TypeScript. Its common result fields are `summary`, `steps`, and `assumptions`. Research planning adds `topic` and `questions`; coding planning may add `testCommand` and `template`. Callers validate the structured response and retain ownership of approval, execution, and status.

## Implementation status

- Immediate combined saved-knowledge and web lookup is registered and mapped from both factual lookup categories.
- Explicit deep research is routed through Growth; the classifier no longer exposes direct research execution for new chat requests.
- The Growth Planner produces bounded research briefs and queues them with the originating opportunity identifier.
- Stale `researching` queue entries can be claimed again after the timeout window.
- Planner's common contract is documented and used by Growth and Coding adapters.
- Config parsing honors an explicitly provided environment mapping.
- Existing automatic knowledge context and grounding protections remain in place.

## Remaining validation / decisions

- Deploy the branch and inspect real conversations for combined-tool invocation, source quality, citation grounding, and per-source failure behavior.
- Tune Growth's thresholds and Planner's web/search budgets from observed false positives, duplicates, latency, and missed opportunities.
- Confirm research freshness/versioning and supersession behavior as persisted research usage grows.
- Verify the stale-claim timeout against the longest legitimate research runs so recovery does not create duplicate active work.
