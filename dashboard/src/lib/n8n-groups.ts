import { getPool } from "./pg-pools";

// Reads the live n8n `Chat` workflow's `Expand Groups To Tools` Code node
// and regex-extracts its hardcoded GROUPS object - this is the only place
// in the whole stack that maps a chat "capability" (research/personal/
// automation/self-growth) to the tool names it unlocks. Reads directly from
// Postgres's `n8n` database (the live/published `workflow_entity` row, not
// the checked-in git file) so this reflects whatever's actually deployed.
//
// Deliberately does NOT eval the jsCode string (not even just the object
// literal) - a plain regex over the known, narrow `key: [...]` shape is
// enough here and carries zero code-execution risk from a value that's
// really just "whatever a live database row currently contains".

const CHAT_WORKFLOW_ID = "9YdYYhVGfsKgj4yz";
const GROUPS_NODE_NAME = "Expand Groups To Tools";

export interface CapabilityGroups {
  groups: Record<string, string[]>;
  alwaysOnTools: string[];
}

export async function getCapabilityGroups(): Promise<CapabilityGroups> {
  const pool = getPool("n8n");
  const result = await pool.query<{ nodes: Array<{ name: string; parameters?: { jsCode?: string } }> }>(
    'SELECT nodes FROM workflow_entity WHERE id = $1',
    [CHAT_WORKFLOW_ID]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Chat workflow (${CHAT_WORKFLOW_ID}) not found in workflow_entity`);
  }

  const node = row.nodes.find((n) => n.name === GROUPS_NODE_NAME);
  const jsCode = node?.parameters?.jsCode;
  if (!jsCode) {
    throw new Error(`"${GROUPS_NODE_NAME}" node not found or has no jsCode - the Chat workflow's Code node shape may have changed`);
  }

  const groupsBlockStart = jsCode.indexOf("GROUPS = {");
  if (groupsBlockStart === -1) {
    throw new Error(`unable to find "GROUPS = {" in "${GROUPS_NODE_NAME}" - the Code node's shape may have changed`);
  }
  const blockEnd = jsCode.indexOf("};", groupsBlockStart);
  const block = jsCode.slice(groupsBlockStart, blockEnd === -1 ? undefined : blockEnd);

  const groups: Record<string, string[]> = {};
  const entryPattern = /(['"]?)([\w-]+)\1\s*:\s*\[([^\]]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(block))) {
    const [, , key, itemsRaw] = match;
    const items = itemsRaw
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    groups[key] = items;
  }

  if (Object.keys(groups).length === 0) {
    throw new Error(`parsed zero groups from "${GROUPS_NODE_NAME}" - the Code node's shape may have changed`);
  }

  // calculate and task_context_manage are always included regardless of
  // classification (see the Code node's own comment) - not part of GROUPS.
  return { groups, alwaysOnTools: ["calculate", "task_context_manage"] };
}
