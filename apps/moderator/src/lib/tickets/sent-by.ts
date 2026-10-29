export type EscalationRow = { entityId: number | null; userId: number | null; createdAt: Date };
export type Escalation = { moderatorId: number | null; at: string };

/** The newest escalation of each ticket, keyed by ticket id. */
export function latestPerTicket(rows: readonly EscalationRow[]): Map<string, Escalation> {
  const newest = new Map<string, EscalationRow>();
  for (const row of rows) {
    if (row.entityId === null) continue;
    const key = String(row.entityId);
    const seen = newest.get(key);
    if (!seen || row.createdAt > seen.createdAt) newest.set(key, row);
  }
  return new Map(
    [...newest].map(([id, r]) => [id, { moderatorId: r.userId, at: r.createdAt.toISOString() }])
  );
}
