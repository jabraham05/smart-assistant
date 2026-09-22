import type { Config } from "../config.js";
import * as db from "../db.js";
import { ollamaChat } from "../ollama.js";

export interface ConsolidateResult {
  documentId: number;
}

// The step the whole "projects" feature exists for: turning a finished
// research run into an actual write-up, not just structured findings/
// citations rows (which is all persistResearch() ever produces - see
// docs/knowledge-engine.md's dated entry, no synthesis-from-notes function
// existed anywhere in this codebase before this). Writes onto the
// EXISTING document already referenced by research_sessions.document_id
// (set by persistResearch) rather than creating a second document for the
// same topic.
export async function consolidateProject(
  config: Config,
  projectId: number,
  researchSessionId: number,
): Promise<ConsolidateResult> {
  const project = await db.getProject(config, projectId);
  if (!project) throw new Error(`project ${projectId} not found`);

  const detail = await db.getResearchSessionDetail(config, researchSessionId);
  if (!detail) throw new Error(`research session ${researchSessionId} not found`);
  if (!detail.session.document_id) {
    throw new Error(`research session ${researchSessionId} has no document to write onto`);
  }

  const findingsText = detail.findings.length
    ? detail.findings
        .map((f, i) => `${i + 1}. [${f.confidence}] ${f.claim}`)
        .join("\n")
    : "(no findings were recorded)";

  const { message } = await ollamaChat(config.ollamaHost, {
    model: config.researchModel,
    messages: [
      {
        role: "system",
        content:
          "You write concise knowledge write-ups for a personal assistant's knowledge base. " +
          "Given a project's rationale and a list of verified research findings, produce a " +
          "well-organized markdown document: a short overview paragraph, then the key points " +
          "as a bulleted or numbered list, grouped by theme if that helps. Only use the " +
          "findings given - do not invent facts. Plain markdown only, no preamble like " +
          "\"Here is the document\".",
      },
      {
        role: "user",
        content: `Project: ${project.title}\n\nRationale: ${project.rationale}\n\nFindings:\n${findingsText}`,
      },
    ],
  });

  const markdown = message.content.trim();
  await db.setDocumentMarkdown(config, detail.session.document_id, markdown);
  await db.updateProject(config, projectId, { status: "done", documentId: detail.session.document_id });

  return { documentId: detail.session.document_id };
}
