import { NextResponse } from "next/server";
import { getPool } from "@/lib/pg-pools";

export async function GET() {
  const pool = getPool("n8n");
  const result = await pool.query(`
    SELECT ee.id, ee."workflowId", w.name AS "workflowName", ee.mode, ee.status,
           ee.finished, ee."startedAt", ee."stoppedAt"
    FROM execution_entity ee
    LEFT JOIN workflow_entity w ON w.id = ee."workflowId"
    ORDER BY ee."startedAt" DESC
    LIMIT 50
  `);
  return NextResponse.json({ executions: result.rows });
}
