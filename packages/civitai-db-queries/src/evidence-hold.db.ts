import { sql, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Ending is read per OWNER off "EvidenceHeldUser" ("heldUntil" = latest end across the owner's
// active holds), never per hold row: a row reaching its date while another hold keeps the owner
// held is not an ending.

/** How many days before its end a hold counts as ending. */
export const EVIDENCE_HOLD_ENDING_DAYS = 14;

// NULL "heldUntil" (held until released) is never ending. `now()` is shifted to UTC to match the
// zoneless column, so the window doesn't move with the session time zone.
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
  return { owners: Number(owners), earliest };
}

/**
 * The manual hold generator evidence places for a CSAM report still being prepared. Until the report
 * is sent it is the only thing holding the owner, so it is never released from the moderator page.
 */
export const GENERATOR_EVIDENCE_HOLD_REASON = 'generator evidence preserved for a CSAM report';

export type EvidenceHoldEntry = {
  id: number;
  role: string;
  reason: string;
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
    .orderBy('h.heldUntil')
    .orderBy('h.userId')
    .limit(limit + 1)
    .offset(offset)
    .execute();

  const page = owners.slice(0, limit);
  if (!page.length) return { items: [], hasMore: false };

  // Ended rows too: an owner can be held by another row while this one has run out.
  const holds = await db
    .selectFrom('EvidenceHold')
    .select([
      'id',
      'userId',
      'role',
      'reason',
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

/**
 * Places a manual hold unless one in force with the same reason already lasts as long as the one
 * asked for, so a repeat does not stack rows. Only `manual`: `subject` and `secondary` holds belong
 * to a CSAM report and the table's role check refuses them without one. A null `releaseAt` holds
 * until released; a date ends the hold in the "EvidenceHeldUser" view, with no job.
 */
export async function placeEvidenceHold(
  db: Kysely<DB>,
  input: {
    userId: number;
    role: 'manual';
    reason: string;
    createdById: number | null;
    releaseAt?: Date | null;
  }
): Promise<{ id: number; created: boolean }> {
  const open = await db
    .selectFrom('EvidenceHold')
    .select('id')
    .where('userId', '=', input.userId)
    .where('role', '=', input.role)
    .where('reason', '=', input.reason)
    .where('releasedAt', 'is', null)
    // Still in force, by the same test as "EvidenceHeldUser": a row past its dates holds nothing.
    .where(sql<boolean>`("releaseAt" IS NULL OR "releaseAt" > now() OR "extendedUntil" > now())`)
    // ...and lasting at least as long as the one asked for: an indefinite request is met only by an
    // indefinite hold, never by a dated one that would lapse first.
    .where(
      input.releaseAt
        ? sql<boolean>`("releaseAt" IS NULL OR GREATEST("releaseAt", COALESCE("extendedUntil", "releaseAt")) >= ${toUtcTimestamp(
            input.releaseAt
          )})`
        : sql<boolean>`"releaseAt" IS NULL`
    )
    .executeTakeFirst();
  if (open) return { id: open.id, created: false };

  const { id } = await db
    .insertInto('EvidenceHold')
    .values({
      userId: input.userId,
      role: input.role,
      reason: input.reason,
      createdById: input.createdById,
      releaseAt: input.releaseAt ? toUtcTimestamp(input.releaseAt) : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { id, created: true };
}

/**
 * Releases one open manual hold. False when there is no such hold: unknown, already released, a
 * report hold, the generator-evidence hold, or a hold under an extension still in force. Those are
 * not a moderator's to end, and a release purges what the hold kept.
 */
export async function releaseEvidenceHold(
  db: Kysely<DB>,
  input: { id: number; releasedById: number; releaseReason: string }
): Promise<boolean> {
  const result = await db
    .updateTable('EvidenceHold')
    .set({
      releasedAt: sql`now() AT TIME ZONE 'UTC'`,
      releasedById: input.releasedById,
      releaseReason: input.releaseReason,
    })
    .where('id', '=', input.id)
    .where('role', '=', 'manual')
    .where('reason', '!=', GENERATOR_EVIDENCE_HOLD_REASON)
    .where('releasedAt', 'is', null)
    // An extension is an outside request to keep the evidence; it is not a moderator's to cut short.
    .where(sql<boolean>`("extendedUntil" IS NULL OR "extendedUntil" <= now())`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

// The columns are zoneless and hold UTC, so a Date is written as its UTC wall time.
const toUtcTimestamp = (date: Date) =>
  sql<Date>`${date.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
