export const SECONDS_PER_DAY = 86400;

export function retentionCutoff(days: number | null, now: number) {
  return days === null ? Number.MIN_SAFE_INTEGER : now - days * SECONDS_PER_DAY;
}

/** Tie each read/write to the policy used to select content, including across a concurrent policy edit. */
export function retentionGuard(db: D1Database, spaceId: string, days: number | null, revision: number) {
  return db.prepare("INSERT INTO retention_assertion(failure) SELECT 'policy_changed'" +
    " WHERE NOT EXISTS(SELECT 1 FROM spaces WHERE id=? AND retention_days IS ? AND retention_rev=?)")
    .bind(spaceId, days, revision);
}
