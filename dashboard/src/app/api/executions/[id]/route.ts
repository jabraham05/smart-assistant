import { NextResponse } from "next/server";
import { getPool } from "@/lib/pg-pools";
import { getExecutionRunData } from "@/lib/flatted-decode";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const executionId = Number(id);
  if (!Number.isInteger(executionId)) {
    return NextResponse.json({ error: "invalid execution id" }, { status: 400 });
  }

  const pool = getPool("n8n");
  const metaResult = await pool.query(
    `SELECT ee.id, ee."workflowId", w.name AS "workflowName", ee.mode, ee.status,
            ee.finished, ee."startedAt", ee."stoppedAt"
     FROM execution_entity ee
     LEFT JOIN workflow_entity w ON w.id = ee."workflowId"
     WHERE ee.id = $1`,
    [executionId]
  );
  if (metaResult.rows.length === 0) {
    return NextResponse.json({ error: `execution ${executionId} not found` }, { status: 404 });
  }

  try {
    const nodeRuns = await getExecutionRunData(executionId);
    return NextResponse.json({ execution: metaResult.rows[0], nodeRuns });
  } catch (e) {
    return NextResponse.json(
      { execution: metaResult.rows[0], nodeRuns: [], error: e instanceof Error ? e.message : String(e) },
      { status: 200 }
    );
  }
}
