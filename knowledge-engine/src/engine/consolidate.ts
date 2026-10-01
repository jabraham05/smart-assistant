import type { Config } from "../config.js";
import * as db from "../db.js";
import { ollamaChat } from "../ollama.js";
import { getCodingTask } from "../lib/coding-orchestrator-client.js";
import type { SearchResult } from "./search.js";
import { createEntity, backfillGraphitiId } from "./entities.js";

export interface ConsolidateResult {
  documentId: number;
}

// Phase 3 of the infrastructure rebuild: a project reaching "done," with a
// real synthesized write-up already in hand, is the single highest-value
// moment for the decision/project/growth ledger - the markdown itself
// makes a far richer episode body than the raw approval moment. Shared by
// all three consolidation paths below rather than duplicated three times.
// Fire-and-forget, same reasoning as every other graphiti-service call in
// this codebase: a slow/unreachable graphiti-service must never delay or
// break project consolidation itself.
// Resolves to the new episode's uuid, or undefined if the write failed -
// never rejects, so a caller chaining .then() off this never needs its own
// try/catch to preserve the fire-and-forget guarantee below.
function writeConsolidatedEpisode(config: Config, project: db.ProjectRow, markdown: string): Promise<string | undefined> {
  return fetch(`${config.graphitiServiceUrl}/episodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `project-consolidated-${project.id}`,
      episodeBody: markdown,
      sourceDescription: "project_consolidated event",
    }),
  })
    .then((res) => res.json() as Promise<{ episodeUuid: string }>)
    .then((body) => body.episodeUuid)
    .catch((e) => {
      console.error(`failed to write project_consolidated episode for project ${project.id}:`, e);
      return undefined;
    });
}

// Phase 1 of the "Amy's world" rework: the single integration point that
// turns a completed project into the durable `entities` row + file
// (engine/entities.ts), using the real trigger that already exists here
// rather than adding a new one. Entity creation is awaited - unlike the
// Graphiti episode write, this IS the durable artifact and must not fail
// silently. graphiti_id is only ever backfilled best-effort once/if the
// already-fire-and-forget episode write resolves, never blocking or
// failing the entity itself.
async function recordConsolidatedEntity(config: Config, project: db.ProjectRow, markdown: string): Promise<void> {
  const episodePromise = writeConsolidatedEpisode(config, project, markdown);
  const entity = await createEntity(config, {
    type: "project",
    name: project.title,
    description: markdown,
    status: "done",
    sourceTable: "projects",
    sourceId: String(project.id),
  });
  void episodePromise.then((graphitiId) => {
    if (graphitiId) void backfillGraphitiId(config, entity.id, graphitiId);
  });
}

// The step the whole "projects" feature exists for: turning finished work
// into an actual write-up, not just scattered rows (structured findings/
// citations for research, a diff/reviewer verdict for coding) - no
// synthesis-from-notes function existed anywhere in this codebase before
// this. Branches on activity_type - the two kinds of evidence (research
// findings vs a code diff/reviewer verdict) don't share a shape, but both
// end up as one markdown document either way.
export async function consolidateProject(config: Config, projectId: number): Promise<ConsolidateResult> {
  const project = await db.getProject(config, projectId);
  if (!project) throw new Error(`project ${projectId} not found`);

  if (project.activity_type === "coding") {
    return consolidateCodingProject(config, project);
  }
  return consolidateResearchProject(config, project);
}

// Real bug found via live testing: approving a research-activity project
// whose topic turned out to already be well-covered just 409'd forever -
// there was no path forward since enqueueTopic refuses to queue something
// already known, and nothing ever ran the consolidation step for it. This
// lets approve finish the project immediately using the knowledge that
// already exists, instead of treating "already known" as a dead end.
export async function consolidateFromExistingKnowledge(
  config: Config,
  project: db.ProjectRow,
  knowledgeResults: SearchResult[],
): Promise<ConsolidateResult> {
  const evidence = knowledgeResults.length
    ? knowledgeResults.map((r, i) => `${i + 1}. ${r.content}`).join("\n\n")
    : "(no specific passages were retrieved, but this topic was judged already well-covered)";

  const markdown = await synthesizeMarkdown(
    config,
    RESEARCH_SYSTEM_PROMPT,
    `Project: ${project.title}\n\nRationale: ${project.rationale}\n\nAlready-known information:\n${evidence}`,
  );

  const document = await db.insertDocument(config, {
    kind: "project",
    sourceType: "existing_knowledge",
    title: project.title,
    domain: project.domain ?? undefined,
    triggerSource: "project_approved",
    status: "complete",
  });
  await db.setDocumentMarkdown(config, document.id, markdown);
  await db.updateProject(config, project.id, { status: "done", documentId: document.id });
  await recordConsolidatedEntity(config, project, markdown);
  return { documentId: document.id };
}

async function synthesizeMarkdown(config: Config, systemPrompt: string, userContent: string): Promise<string> {
  const { message } = await ollamaChat(config.ollamaHost, {
    model: config.researchModel,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });
  return message.content.trim();
}

const RESEARCH_SYSTEM_PROMPT =
  "You write concise knowledge write-ups for a personal assistant's knowledge base. " +
  "Given a project's rationale and a list of verified research findings, produce a " +
  "well-organized markdown document: a short overview paragraph, then the key points " +
  "as a bulleted or numbered list, grouped by theme if that helps. Only use the " +
  "findings given - do not invent facts. Plain markdown only, no preamble like " +
  '"Here is the document".';

// Writes onto the EXISTING document already referenced by
// research_sessions.document_id (set by persistResearch) rather than
// creating a second document for the same topic.
async function consolidateResearchProject(config: Config, project: db.ProjectRow): Promise<ConsolidateResult> {
  if (!project.research_session_id) {
    throw new Error(`project ${project.id} has no linked research session`);
  }
  const detail = await db.getResearchSessionDetail(config, project.research_session_id);
  if (!detail) throw new Error(`research session ${project.research_session_id} not found`);
  if (!detail.session.document_id) {
    throw new Error(`research session ${project.research_session_id} has no document to write onto`);
  }

  // Excludes unverified findings rather than relying on the synthesis
  // prompt's existing "do not invent facts" instruction alone - an
  // unverified claim fed in alongside verified ones could get smoothed
  // into the final markdown's prose and lose its tag entirely, the same
  // "prompt alone isn't reliable enough" lesson this codebase keeps
  // re-learning.
  const groundedFindings = detail.findings.filter((f) => f.confidence !== "unverified");
  const findingsText = groundedFindings.length
    ? groundedFindings.map((f, i) => `${i + 1}. [${f.confidence}] ${f.claim}`).join("\n")
    : "(no verified findings were recorded)";

  const markdown = await synthesizeMarkdown(
    config,
    RESEARCH_SYSTEM_PROMPT,
    `Project: ${project.title}\n\nRationale: ${project.rationale}\n\nFindings:\n${findingsText}`,
  );

  await db.setDocumentMarkdown(config, detail.session.document_id, markdown);
  await db.updateProject(config, project.id, { status: "done", documentId: detail.session.document_id });
  await recordConsolidatedEntity(config, project, markdown);
  return { documentId: detail.session.document_id };
}

const CODING_SYSTEM_PROMPT =
  "You write concise knowledge write-ups for a personal assistant's knowledge base. " +
  "Given a coding project's rationale, its code diff, test output, and reviewer verdict, " +
  "produce a well-organized markdown document: what was built and why, the key " +
  "implementation points worth remembering, and a link to the pull request if given. " +
  "Only use the evidence given - do not invent facts about what changed. Plain markdown " +
  'only, no preamble like "Here is the document".';

// No pre-existing document for a coding task (coding_tasks lives in a
// separate database this service never touches otherwise) - creates a new
// one, unlike the research path which updates an existing row.
async function consolidateCodingProject(config: Config, project: db.ProjectRow): Promise<ConsolidateResult> {
  if (!project.coding_task_id) {
    throw new Error(`project ${project.id} has no linked coding task`);
  }
  const task = await getCodingTask(config, project.coding_task_id);
  if (!task) throw new Error(`coding task ${project.coding_task_id} not found`);

  const evidence = [
    `Task: ${task.task_description}`,
    task.pr_url ? `Pull request: ${task.pr_url}` : null,
    task.reviewer_reason ? `Reviewer notes: ${task.reviewer_reason}` : null,
    // Capped - a real diff/test log can be sizable and this is one bounded
    // synthesis call, not a multi-step agent run.
    task.diff ? `Diff:\n${task.diff.slice(0, 8000)}` : null,
    task.test_output ? `Test output:\n${task.test_output.slice(0, 4000)}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");

  const markdown = await synthesizeMarkdown(
    config,
    CODING_SYSTEM_PROMPT,
    `Project: ${project.title}\n\nRationale: ${project.rationale}\n\n${evidence}`,
  );

  const document = await db.insertDocument(config, {
    kind: "project",
    sourceType: "coding_task",
    title: project.title,
    domain: project.domain ?? undefined,
    triggerSource: "project_approved",
    status: "complete",
  });
  await db.setDocumentMarkdown(config, document.id, markdown);
  await db.updateProject(config, project.id, { status: "done", documentId: document.id });
  await recordConsolidatedEntity(config, project, markdown);
  return { documentId: document.id };
}
