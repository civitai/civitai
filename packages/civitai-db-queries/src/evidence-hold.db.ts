import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Whose evidence hold is about to end, read per OWNER off "EvidenceHeldUser", the one definition of
// held: its "heldUntil" is the latest end across the owner's active holds, NULL when one of them has no
// end date. A report row reaching its date while another hold keeps its owner held is not an ending,
// and counting rows would alarm on it. The moderator page, its badge and the main app's alert job all
// read these, so they cannot disagree on who is ending.

/** How many days before its end a hold counts as ending. A fixed requirement, not a setting. */
export const EVIDENCE_HOLD_ENDING_DAYS = 14;

// A NULL "heldUntil" (no end date) never compares true, so it is never ending. The clock is read in
// UTC, as the column is, so the window does not move with the session's time zone.
const endingSoon = sql<boolean>`h."heldUntil" <= (now() AT TIME ZONE 'UTC') + make_interval(days => ${sql.lit(
  EVIDENCE_HOLD_ENDING_DAYS
)})`;

// The columns are zoneless timestamps holding UTC; read as-is, node-postgres would take them as
// server-local time.
const utc = (column: string) => sql<Date | null>`${sql.ref(column)} AT TIME ZONE 'UTC'`;

export async function countEvidenceHoldsEnding(
  db: Kysely<DB>
): Promise<{ owners: number; earliest: Date | null }> {
  const { owners, earliest } = await db
    .selectFrom('EvidenceHeldUser as h')
    .select([
      sql<number>`count(*)::int`.as('owners'),
      sql<Date | null>`min(h."heldUntil") AT TIME ZONE 'UTC'`.as('earliest'),
    ])
    .where(endingSoon)
    .executeTakeFirstOrThrow();
  // A count that arrived as a string ("0") would be truthy and send an alert for nobody.
  return { owners: Number(owners), earliest };
}

export type EvidenceHoldEntry = {
  id: number;
  role: string;
  csamReportId: number | null;
  releaseAt: Date | null;
  extendedUntil: Date | null;
  extensionRequestedBy: string | null;
  extensionReference: string | null;
};

export type EvidenceHeldOwner = {
  userId: number;
  username: string | null;
  heldUntil: Date | null;
  holds: EvidenceHoldEntry[];
};

/** Held owners, the soonest end first and owners with no end date last. */
export async function listEvidenceHeldOwners(
  db: Kysely<DB>,
  { endingOnly, limit, offset }: { endingOnly: boolean; limit: number; offset: number }
): Promise<{ items: EvidenceHeldOwner[]; hasMore: boolean }> {
  let query = db
    .selectFrom('EvidenceHeldUser as h')
    .leftJoin('User as u', 'u.id', 'h.userId')
    .select(['h.userId', 'u.username', utc('h.heldUntil').as('heldUntil')]);
  if (endingOnly) query = query.where(endingSoon);
  const owners = await query
    // Ascending puts NULLs last in Postgres.
    .orderBy('h.heldUntil')
    .orderBy('h.userId')
    .limit(limit + 1)
    .offset(offset)
    .execute();

  const page = owners.slice(0, limit);
  if (!page.length) return { items: [], hasMore: false };

  // Every unreleased row, ended ones included: a report row past its date beside a hold still
  // running is exactly the case the per-owner end exists for, so the page shows both.
  const holds = await db
    .selectFrom('EvidenceHold')
    .select([
      'id',
      'userId',
      'role',
      'csamReportId',
      utc('releaseAt').as('releaseAt'),
      utc('extendedUntil').as('extendedUntil'),
      'extensionRequestedBy',
      'extensionReference',
    ])
    .where(
      'userId',
      'in',
      page.map((o) => o.userId)
    )
    .where('releasedAt', 'is', null)
    .orderBy('id')
    .execute();

  const byOwner = new Map<number, EvidenceHoldEntry[]>();
  for (const { userId, ...hold } of holds) {
    const list = byOwner.get(userId);
    if (list) list.push(hold);
    else byOwner.set(userId, [hold]);
  }
  return {
    items: page.map((owner) => ({ ...owner, holds: byOwner.get(owner.userId) ?? [] })),
    hasMore: owners.length > limit,
  };
}
