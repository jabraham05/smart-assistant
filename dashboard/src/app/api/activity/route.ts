import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/pg-pools";
import { listActiveGoals, listOpenTaskContexts } from "@/lib/event-bus-client";

interface ActivityItem {
  kind: "event" | "execution";
  timestamp: string;
  summary: string;
  detail: Record<string, unknown>;
  executionId?: number;
}

export async function GET(req: NextRequest) {
  const since = req.nextUrl.searchParams.get("since");
  const sinceDate = since ?? new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const [eventsResult, executionsResult, activeGoalsResult, openTaskContextsResult] = await Promise.allSettled([
    getPool("events").query(
      `SELECT id, source, type, payload, occurred_at FROM events WHERE occurred_at > $1 ORDER BY occurred_at DESC LIMIT 50`,
      [sinceDate]
    ),
    getPool("n8n").query(
      `SELECT ee.id, ee."workflowId", w.name AS "workflowName", ee.status, ee."startedAt"
       FROM execution_entity ee
       LEFT JOIN workflow_entity w ON w.id = ee."workflowId"
       WHERE ee."startedAt" > $1
       ORDER BY ee."startedAt" DESC
       LIMIT 50`,
      [sinceDate]
    ),
    listActiveGoals(),
    listOpenTaskContexts(),
  ]);

  const items: ActivityItem[] = [];

  if (eventsResult.status === "fulfilled") {
    for (const row of eventsResult.value.rows) {
      items.push({
        kind: "event",
        timestamp: row.occurred_at,
        summary: `${row.source}.${row.type}`,
        detail: row,
      });
    }
  }

  if (executionsResult.status === "fulfilled") {
    for (const row of executionsResult.value.rows) {
      items.push({
        kind: "execution",
        timestamp: row.startedAt,
        summary: `${row.workflowName ?? row.workflowId} (${row.status})`,
        detail: row,
        executionId: row.id,
      });
    }
  }

  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const cursor = items[0]?.timestamp ?? sinceDate;

  return NextResponse.json({
    items,
    cursor,
    activeGoals: activeGoalsResult.status === "fulfilled" ? activeGoalsResult.value : { error: activeGoalsResult.reason?.message ?? String(activeGoalsResult.reason) },
    openTaskContexts: openTaskContextsResult.status === "fulfilled" ? openTaskContextsResult.value : { error: openTaskContextsResult.reason?.message ?? String(openTaskContextsResult.reason) },
  });
}
