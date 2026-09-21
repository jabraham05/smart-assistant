import type { QueryResult } from "pg";
import { getPool, type DatabaseName } from "./pg-pools";

// This dashboard uses the same `assistant` credential every other service
// uses (no dedicated read-only Postgres role exists across the 5
// databases), so read-only safety is enforced here instead, in two
// independent layers:
//
//   1. assertReadOnly() below - a fast, friendly pre-check that rejects
//      anything but a single SELECT/WITH statement before ever opening a
//      connection.
//   2. runReadOnlyQuery()'s BEGIN TRANSACTION READ ONLY - Postgres's own
//      server-enforced read-only mode. This is the real safety boundary:
//      even if the regex below had a gap, Postgres itself rejects any
//      mutating statement inside a READ ONLY transaction.
export function assertReadOnly(sql: string): void {
  // Strip line comments first so a mutation hidden after `--` can't slip
  // past either check below.
  const withoutComments = sql.replace(/--.*$/gm, "").trim();
  if (!withoutComments) {
    throw new Error("Empty statement");
  }

  const withoutTrailingSemi = withoutComments.replace(/;\s*$/, "");
  // A stacked "SELECT 1; DROP TABLE x" would pass a first-word-only check -
  // reject multiple statements outright.
  if (withoutTrailingSemi.includes(";")) {
    throw new Error("Only a single statement is allowed");
  }

  const firstWord = withoutTrailingSemi.match(/^\s*(\w+)/)?.[1]?.toUpperCase();
  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    throw new Error("Only SELECT or WITH (read) statements are allowed");
  }

  // Belt-and-suspenders: catches a mutating CTE like
  // `WITH x AS (INSERT INTO ... RETURNING ...) SELECT * FROM x`, which a
  // first-word check alone would miss since the statement still starts
  // with WITH.
  const forbidden = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|COPY|CALL|VACUUM|REFRESH|MERGE)\b/i;
  if (forbidden.test(withoutTrailingSemi)) {
    throw new Error("Statement contains a disallowed keyword");
  }
}

export async function runReadOnlyQuery(database: DatabaseName, sql: string): Promise<QueryResult> {
  assertReadOnly(sql);

  const pool = getPool(database);
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const result = await client.query(sql);
    await client.query("ROLLBACK");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
