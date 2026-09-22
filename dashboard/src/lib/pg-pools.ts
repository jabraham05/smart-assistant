import { Pool } from "pg";

// The 5 real databases on the shared `postgres` container - see
// postgres/init/*.sql. There is exactly one Postgres role (`assistant`)
// across all of them; a dedicated read-only role doesn't exist, so safety
// for ad-hoc queries is enforced in readonly-sql.ts instead.
export const DATABASE_NAMES = ["postgres", "n8n", "research", "coding_tasks", "events"] as const;
export type DatabaseName = (typeof DATABASE_NAMES)[number];

const pools = new Map<DatabaseName, Pool>();

export function getPool(database: DatabaseName): Pool {
  const existing = pools.get(database);
  if (existing) return existing;

  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? "postgres",
    user: process.env.POSTGRES_USER ?? "assistant",
    password: process.env.POSTGRES_PASSWORD,
    database,
    max: 3,
  });
  pools.set(database, pool);
  return pool;
}

export function isDatabaseName(value: string): value is DatabaseName {
  return (DATABASE_NAMES as readonly string[]).includes(value);
}
