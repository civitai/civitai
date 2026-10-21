import { sql, type RawBuilder } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbRead, dbWrite } from './db';
import { insertModActivityBatch } from './mod-activity';
import { FLAG_KEPT_THROUGH_BLOCK } from '$lib/image-review';
import { BAN_REASONS_ALWAYS_REMOVING_MEDIA } from '$lib/enforcement';

/** Created by a migration that may not be applied yet; the guard checks it once it is. */
export const EVIDENCE_HOLD_TABLE = 'EvidenceHold';

const BAN_NOTES_PATTERN = '(csam|ncmec|minor)';

/** Each reason a user's review flags may not be cleared in bulk, as a boolean over `userId`. */
export function flagClearHoldLegs(userId: RawBuilder<number>, evidenceHoldTable: boolean) {
  const reasonCode = sql`u.meta #>> '{banDetails,reasonCode}'`;
  const legs = {
    csamReport: sql<boolean>`EXISTS (SELECT 1 FROM "CsamReport" c WHERE c."userId" = ${userId})`,
    csamReportSecondary: sql<boolean>`EXISTS (
      SELECT 1 FROM "CsamReport" c
      WHERE CASE WHEN (c."details" ->> 'secondaryUserId') ~ '^[0-9]{1,9}$'
                 THEN (c."details" ->> 'secondaryUserId')::int END = ${userId}
    )`,
    ban: sql<boolean>`EXISTS (
      SELECT 1 FROM "User" u
      WHERE u.id = ${userId} AND u."bannedAt" IS NOT NULL
        AND (
          ${reasonCode} IS NULL
          OR ${reasonCode} IN (${sql.join([...BAN_REASONS_ALWAYS_REMOVING_MEDIA])})
          OR (${reasonCode} = 'Other' AND concat_ws(' ',
                u.meta #>> '{banDetails,detailsInternal}',
                u.meta #>> '{banDetails,detailsExternal}') ~* ${BAN_NOTES_PATTERN})
        )
    )`,
    evidenceHold: evidenceHoldTable
      ? sql<boolean>`EXISTS (SELECT 1 FROM ${sql.table(
          EVIDENCE_HOLD_TABLE
        )} h WHERE h."userId" = ${userId})`
      : sql<boolean>`false`,
  };
  return legs;
}

export type FlagClearHoldLeg = keyof ReturnType<typeof flagClearHoldLegs>;

async function hasEvidenceHoldTable(db: Kysely<DB>): Promise<boolean> {
  const { rows } = await sql<{ present: boolean }>`
    SELECT to_regclass(${`"${EVIDENCE_HOLD_TABLE}"`}) IS NOT NULL AS present`.execute(db);
  return !!rows[0]?.present;
}

function anyHold(userId: RawBuilder<number>, evidenceHoldTable: boolean) {
  return sql<boolean>`(${sql.join(
    Object.values(flagClearHoldLegs(userId, evidenceHoldTable)),
    sql` OR `
  )})`;
}

/** Which of `userIds` are held, and by what. Absent from the map = not held. */
export async function getFlagClearHolds(
  userIds: number[],
  db: Kysely<DB> = dbRead
): Promise<Map<number, FlagClearHoldLeg[]>> {
  const held = new Map<number, FlagClearHoldLeg[]>();
  if (!userIds.length) return held;
  const evidenceHoldTable = await hasEvidenceHoldTable(db);
  const legs = flagClearHoldLegs(sql<number>`t.id`, evidenceHoldTable);
  const { rows } = await sql<{ id: number } & Record<FlagClearHoldLeg, boolean>>`
    SELECT t.id, ${sql.join(
      Object.entries(legs).map(([name, leg]) => sql`${leg} AS ${sql.ref(name)}`)
    )}
    FROM unnest(${userIds}::int[]) AS t(id)`.execute(db);
  for (const row of rows) {
    const hit = (Object.keys(legs) as FlagClearHoldLeg[]).filter((leg) => row[leg]);
    if (hit.length) held.set(row.id, hit);
  }
  return held;
}

/** Clears the review flag from every one of `userId`'s removed images whose flag `dismissReviewFlag`
 *  would clear, unless the user is held. The hold is repeated in the UPDATE so the check and the
 *  write are one statement. Returns the cleared image ids. */
export async function clearRemovedFlagsUnlessHeld(
  db: Kysely<DB>,
  userId: number,
  evidenceHoldTable: boolean
): Promise<number[]> {
  const rows = await db
    .updateTable('Image')
    .set({ needsReview: null })
    .where('userId', '=', userId)
    .where('needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
    .where('ingestion', '=', 'Blocked')
    .where(sql<boolean>`NOT ${anyHold(sql<number>`${userId}::int`, evidenceHoldTable)}`)
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}

export type ClearUserFlagsResult =
  | { ok: true; cleared: number; remaining: number }
  | { ok: false; reason: 'held' | 'changed' };

class QueueChanged extends Error {}

/**
 * `dismissReviewFlag` for all of one user's removed, flagged images, in one transaction: the same
 * update and the same ModActivity row per image. Refused for a held user. `expectedCount` is what the
 * moderator confirmed; any other number rolls back, so nothing is cleared that was not shown.
 */
export async function clearUserCsamFlags({
  userId,
  expectedCount,
  moderatorId,
}: {
  userId: number;
  expectedCount: number;
  moderatorId: number;
}): Promise<ClearUserFlagsResult> {
  try {
    return await dbWrite.transaction().execute(async (trx) => {
      const evidenceHoldTable = await hasEvidenceHoldTable(trx);
      const held = (await getFlagClearHolds([userId], trx)).get(userId);
      if (held) {
        console.warn('[csam-flag-clear] refused', { userId, moderatorId, held });
        return { ok: false, reason: 'held' } as const;
      }
      const cleared = await clearRemovedFlagsUnlessHeld(trx, userId, evidenceHoldTable);
      if (cleared.length !== expectedCount) throw new QueueChanged();
      await insertModActivityBatch(trx, {
        userId: moderatorId,
        entityType: 'image',
        entityIds: cleared,
        activity: 'dismissReviewFlag',
      });
      const remaining = await trx
        .selectFrom('Image')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('userId', '=', userId)
        .where('needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
        .executeTakeFirstOrThrow();
      return { ok: true, cleared: cleared.length, remaining: Number(remaining.count) } as const;
    });
  } catch (e) {
    if (e instanceof QueueChanged) return { ok: false, reason: 'changed' };
    throw e;
  }
}
