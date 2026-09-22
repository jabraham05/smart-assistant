import { parse } from "flatted";
import { getPool } from "./pg-pools";

// n8n serializes execution_data.data with the plain `flatted` npm package,
// not JSON - confirmed in this project's own earlier investigation
// (docs/known-gotchas.md, docs/coding-agent-pipeline.md). It's a real
// public package with no n8n-specific magic, so this decodes it directly
// from a normal Postgres read, no need to shell into the n8n container.

interface NodeRun {
  startTime?: number;
  executionTime?: number;
  // AI sub-nodes (LangChain tool/model/memory nodes, e.g. "MCP Client
  // Tool", "Ollama Chat Model") connect via special types - ai_tool,
  // ai_languageModel, ai_memory - not the standard "main" data flow.
  // Confirmed live: "MCP Client Tool"'s real output landed under ai_tool,
  // not main, so this can't assume one fixed key.
  data?: Record<string, (Array<{ json: unknown }> | null)[] | undefined>;
  error?: { message: string };
}

interface DecodedExecutionData {
  resultData: {
    runData: Record<string, NodeRun[]>;
  };
}

export interface NodeRunSummary {
  nodeName: string;
  runIndex: number;
  status: "success" | "error";
  executionTime: number | null;
  output: unknown;
  errorMessage: string | null;
}

export async function getExecutionRunData(executionId: number): Promise<NodeRunSummary[]> {
  const pool = getPool("n8n");
  const result = await pool.query<{ data: string }>(
    'SELECT data FROM execution_data WHERE "executionId" = $1',
    [executionId]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`No execution_data row for execution ${executionId}`);
  }

  let decoded: DecodedExecutionData;
  try {
    decoded = parse(row.data) as DecodedExecutionData;
  } catch (e) {
    throw new Error(`Failed to flatted.parse execution_data: ${e instanceof Error ? e.message : String(e)}`);
  }

  const summaries: NodeRunSummary[] = [];
  const runData = decoded.resultData?.runData ?? {};
  for (const [nodeName, runs] of Object.entries(runData)) {
    runs.forEach((run, runIndex) => {
      // n8n's exact runData shape has drifted across versions historically
      // (whether data.main is nullable per branch, etc.) - guard each run
      // individually so one unexpected shape doesn't break the whole list.
      try {
        const connectionType = run.data ? Object.keys(run.data)[0] : undefined;
        const output = connectionType ? run.data?.[connectionType]?.[0]?.[0]?.json ?? null : null;
        summaries.push({
          nodeName,
          runIndex,
          status: run.error ? "error" : "success",
          executionTime: run.executionTime ?? null,
          output,
          errorMessage: run.error?.message ?? null,
        });
      } catch (e) {
        summaries.push({
          nodeName,
          runIndex,
          status: "error",
          executionTime: null,
          output: null,
          errorMessage: `unable to parse this node's run data: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    });
  }

  return summaries;
}
