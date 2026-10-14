# Amy knowledge acquisition and research ownership plan

## Purpose

Make Amy reliable when answering from stored knowledge or live web results, and give each system one clear responsibility for deciding, planning, and doing durable research.

This plan extends the existing knowledge engine and agent-service work. It does not create another knowledge store: knowledge-engine remains the durable store for sourced documents and research findings. User-specific facts remain in memory-engine.

## Current state

- knowledge-engine stores documents, sources, chunks, research sessions, findings, and citations. It supports hybrid knowledge search and a research pipeline that can search the knowledge base and web, fetch pages, record findings, and persist research results.
- This branch now injects relevant, non-expired knowledge through context_builder.py alongside the existing memory context. knowledge_search remains available for deliberate recall.
- A single-turn `knowledge_gap` is now recorded for Growth without directly queuing ambient research. Knowledge opportunities invoke the bounded Planner, which can scope against stored knowledge and web passages before queuing a brief for Research.
- Planner/queue failures leave a retryable Growth learning plan; the Growth background sweep retries it. The queue's `triggerSource` carries the Growth opportunity id.
- Search-result fidelity instructions, citation URL checks, and a narrow high-specificity grounding backstop now cover both explicit retrieval results and injected context.
- This is branch implementation; deployment and end-to-end runtime verification remain outstanding.

## Ownership model

| System | Responsibility | Does not own |
| --- | --- | --- |
| Amy conversation agent | Answer the current user turn; use injected knowledge, explicit knowledge recall when needed, and web search for current or missing information. Start research when the user explicitly asks for it. | Deciding that a one-off conversational gap deserves autonomous durable research. |
| Growth | Detect recurring or high-value knowledge gaps from observations; score and decide whether an ambient gap merits follow-up. | Doing the research or writing the research brief itself. |
| Planner agent | On demand, turn a Growth-approved research opportunity into a bounded brief. It may use web search to clarify the topic, validate that the gap is real, find existing coverage, and scope useful questions. | Independently promoting observations or launching open-ended research. |
| Research agent / knowledge engine | Execute an explicit research brief, collect and cross-check sources, persist findings and citations in knowledge-engine, and report completion. | Deciding whether an ambient opportunity is worth pursuing. |
| Coder | Implement an approved technical plan. | Research prioritization or knowledge acquisition during Amy's conversation. |

The Planner is a specialist invoked by Growth when needed, not another continuously acting coordinator. Growth owns the decision; Planner owns the task definition; Research owns execution and persistence. A direct user request for research can go straight to Research without waiting for Growth.

## End-to-end flows

### Answering a conversational question

1. Before Amy drafts a response, context_builder searches memory-engine and knowledge-engine in parallel for relevant context.
2. High-confidence, fresh knowledge is presented as a source Amy can use. Partial matches are labeled as incomplete and must not be presented as a complete answer.
3. If the injected material does not answer the question, Amy uses web_search for live or missing information. Explicit knowledge_search remains available for deliberate recall or follow-up.
4. A grounding safety check compares specific claims in the draft against the actual sources available this turn, including injected knowledge and memory as well as tool results. If claims exceed the evidence, Amy retries with a constrained instruction to answer only what is supported, state what is unknown, or search further.
5. The current conversational answer does not automatically become a durable research task.

### Deciding whether to do durable research

1. A detected gap is recorded as a Growth observation; it does not immediately enqueue research from Amy's live turn.
2. Growth aggregates and scores observations, considering recurrence, likely reuse, confidence that the gap is real, existing knowledge coverage, urgency/freshness, and effort.
3. When an opportunity meets the configured bar, Growth invokes Planner with the evidence and existing knowledge context.
4. Planner returns a bounded brief: topic, key questions, exclusions/scope, expected useful outcome, evidence for the gap, and a deduplication key. Planner may use web search to validate and scope, but cannot launch Research itself.
5. Growth records the brief and authorizes/queues one research job. The job is idempotent and linked to the opportunity and brief.
6. Research executes the brief, saves a sourced document and structured findings in knowledge-engine, and reports status back to Growth.
7. Future Amy turns can retrieve the persisted result through automatic knowledge context.

## Work plan

### 1. Close the grounding gap

- Add a clear system-prompt instruction for web_search, knowledge_search, and research results: describe only what the returned evidence supports; do not invent details or citations.
- Wire the ungrounded-specifics safety check into the live reply path if it is not already active there.
- Include auto-injected relevant knowledge and memory in the evidence set supplied to that check, not only explicit tool results.
- On a failed grounding check, retry with a corrective instruction and preserve an honest fallback if the evidence remains insufficient.

### 2. Add automatic knowledge retrieval

- Extend context_builder to search knowledge-engine alongside its existing memory search, without enabling stale results by default.
- Apply relevance filtering and a small context budget so broad or noisy matches do not crowd out the conversation.
- Carry source, date/freshness, and retrieval confidence into the prompt context.
- Render strong matches as usable evidence and borderline/partial matches as explicitly incomplete. Instruct Amy to use web_search when a partial match leaves material questions unanswered.
- Keep knowledge_search as an explicit deliberate-recall tool and web_search as the explicit live/new-information tool. They serve different jobs and do not need to be merged.
- Track injected knowledge in turn diagnostics so retrieval and grounding behavior can be inspected.

### 3. Move ambient research ownership to Growth

- Remove the live-turn fire-and-forget enqueue based solely on `classification.knowledge_gap_topic`.
- Continue recording useful gap observations for Growth, with enough evidence and topic normalization to aggregate repeated signals.
- Define Growth promotion criteria and ensure existing coverage, duplicate/in-progress tasks, freshness, recurrence, reuse value, and cost are considered.
- Add a knowledge-gap promotion route that calls Planner and then queues Research; the current generic opportunity-to-proposal path is not sufficient by itself.
- Keep explicit user requests for research on a direct Research path.
- Make task creation idempotent and link the observation, opportunity, brief, research session, and resulting knowledge document for auditability.

### 4. Add the bounded Planner capability

- Implement Planner as an on-demand specialist with a narrow input/output contract, not as another general conversational agent.
- Input: Growth opportunity, supporting observations, current knowledge-search results, and any relevant domain freshness policy.
- Output: a bounded research brief plus a rationale and confidence assessment, or a recommendation not to research because coverage already exists or the gap is too uncertain.
- Permit web search only to validate the gap and scope the brief. Planner cannot enqueue work, modify Amy's behavior, or persist final research findings.
- Require Growth to own the final promotion decision and Research to own execution.

### 5. Persist research as maintained knowledge

- Research results are durable, sourced knowledge-engine documents/findings, not an informal note Amy continuously edits during chat.
- Store provenance, research date, topic/domain, and freshness metadata so retrieval and future refresh decisions can be grounded.
- Prefer new, versioned research records with explicit supersession or refresh links over silent overwrites. Update behavior should preserve provenance and history.
- Define how Growth or a scheduled maintenance process identifies stale/contradicted research for refresh; do not make every conversation trigger an update.

## Acceptance criteria

- A well-covered knowledge-base question can be answered from automatic context without an explicit knowledge_search call, and the trace shows what was injected.
- A missing or materially incomplete match leads Amy to search or clearly state uncertainty rather than invent specifics.
- A thin injected match cannot bypass the grounding check; fabricated details are rejected or corrected before the reply is returned.
- A one-off observed gap is recorded but does not independently start ambient research.
- A recurring/high-value gap can be promoted by Growth, scoped by Planner, and executed by Research with a traceable brief and persisted sources/findings.
- Duplicate observations do not create duplicate active research jobs.
- An explicit user request to research a topic can start Research directly.
- Retrieved research exposes its source and age, and stale content is excluded or flagged according to domain freshness policy.

## Decisions to settle during implementation

- Calibrate automatic-injection relevance thresholds against real retrieval scores and false-positive cases; do not assume a universal numeric threshold from one domain.
- Decide how many knowledge chunks fit the context budget and how partial-match status is derived from score, result count, source coverage, and query coverage.
- Set Growth promotion thresholds from observed outcomes, including a clear route for an urgent but non-recurring gap if one is needed.
- Choose the Planner's web-search budget, timeout, and behavior when it cannot confidently scope the task.
- Specify document supersession/refresh metadata and which process owns refresh scheduling.

## Suggested delivery order

1. Grounding instruction and live safety-net coverage, including injected evidence when injection lands.
2. Knowledge context retrieval with freshness, partial-match labeling, tracing, and web fallback behavior.
3. Growth opportunity-to-research promotion contract and idempotent task lifecycle.
4. Planner brief generation and its bounded web-search capability.
5. Research persistence/versioning and end-to-end verification of the full Growth → Planner → Research flow.
