import type { Config } from "../config.js";
import { getDomainSkill } from "../db.js";

export interface DomainPolicy {
  sourcePriority: string[];
  freshnessRequired: boolean;
  versionField: string | null;
}

const DEFAULT_POLICY: DomainPolicy = {
  sourcePriority: [],
  freshnessRequired: false,
  versionField: null,
};

// Resolves a domain's policy from the database-backed domain_skills table
// (editable via direct SQL, same as hand-editing the personas/skills Data
// Tables today - no admin UI needed for v1). A domain with no row, or no
// domain given at all, gets the deterministic default - this is additive
// config, never a required registration step for a new domain to work.
// The engine (search()/router.ts/verify()) takes this resolved policy as a
// plain parameter and branches on it generically - zero per-domain `if
// (domain === 'warframe')`-style code anywhere, which is the actual proof
// of "one shared engine."
export async function getDomainPolicy(config: Config, domain?: string): Promise<DomainPolicy> {
  if (!domain) return DEFAULT_POLICY;

  const row = await getDomainSkill(config, domain);
  if (!row) return DEFAULT_POLICY;

  return {
    sourcePriority: row.source_priority,
    freshnessRequired: row.freshness_required,
    versionField: row.version_field,
  };
}
