import { sql, type RawBuilder } from '@civitai/db/kysely';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { env } from '$env/dynamic/private';
import { dbRead, dbWrite } from './db';
import { insertModActivityBatch } from './mod-activity';
import { FLAG_KEPT_THROUGH_BLOCK } from '$lib/image-review';
import { BAN_REASONS_ALWAYS_REMOVING_MEDIA } from '$lib/enforcement';

/**
 * The one definition of a hold marker, and the table behind it. A migration that may not be applied
 * yet creates both; the guard reads the view once it exists.
 */
export const HOLD_MARKER_VIEW = 'EvidenceHeldUser';
export const HOLD_MARKER_TABLE = 'EvidenceHold';

/** `drift`: the table without its view, so the view was dropped or renamed. Held until it is back. */
export type HoldMarkerState = 'view' | 'none' | 'drift';

const DEFAULT_BAN_NOTES_PATTERN = '(csam|ncmec|minor)';

/**
 * Matched case-insensitively against an "Other" ban's notes. The deployed pattern comes from
 * `MOD_HOLD_BAN_NOTES_PATTERN`; this default is the fallback. It is a Postgres regex: word
 * boundaries are `\m` (start), `\M` (end) and `\y` (either), never `\b`, which Postgres reads as
 * a backspace.
 */
function banNotesPattern(): string {
  return env.MOD_HOLD_BAN_NOTES_PATTERN || DEFAULT_BAN_NOTES_PATTERN;
}

/** Each reason a user's review flags may not be cleared in bulk, as a boolean over `userId`. */
export function flagClearHoldLegs(userId: RawBuilder<number>, marker: HoldMarkerState) {
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
                u.meta #>> '{banDetails,detailsExternal}') ~* ${banNotesPattern()})
        )
    )`,
    // Any image the clear would touch that a report lists, whoever the report names.
    reportedImage: sql<boolean>`EXISTS (
      SELECT 1 FROM "Image" ri
      JOIN "CsamReport" rc ON rc."images" @> jsonb_build_array(jsonb_build_object('id', ri.id))
      WHERE ri."userId" = ${userId}
        AND ri."needsReview" = ${FLAG_KEPT_THROUGH_BLOCK}
        AND ri."ingestion" = 'Blocked'
    )`,
    evidenceHold:
      marker === 'view'
        ? sql<boolean>`EXISTS (SELECT 1 FROM ${sql.table(
            HOLD_MARKER_VIEW
          )} h WHERE h."userId" = ${userId})`
        : marker === 'drift'
        ? sql<boolean>`true`
        : sql<boolean>`false`,
  };
  return legs;
}

export type FlagClearHoldLeg = keyof ReturnType<typeof flagClearHoldLegs>;

async function holdMarkerState(db: Kysely<DB>): Promise<HoldMarkerState> {
  const { rows } = await sql<{ view: unknown; table: unknown }>`
    SELECT to_regclass(${`"${HOLD_MARKER_VIEW}"`}) IS NOT NULL AS view,
           to_regclass(${`"${HOLD_MARKER_TABLE}"`}) IS NOT NULL AS table`.execute(db);
  const row = rows[0];
  if (row?.view === true) return 'view';
  return row?.view === false && row?.table === false ? 'none' : 'drift';
}

function anyHold(userId: RawBuilder<number>, marker: HoldMarkerState) {
  return sql<boolean>`(${sql.join(Object.values(flagClearHoldLegs(userId, marker)), sql` OR `)})`;
}

/** Which of `userIds` are held, and by what. Absent from the map = not held. */
export async function getFlagClearHolds(
  userIds: number[],
  db: Kysely<DB> = dbRead
): Promise<Map<number, FlagClearHoldLeg[]>> {
  const held = new Map<number, FlagClearHoldLeg[]>();
  if (!userIds.length) return held;
  const marker = await holdMarkerState(db);
  const legs = flagClearHoldLegs(sql<number>`t.id`, marker);
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
  marker: HoldMarkerState
): Promise<number[]> {
  const rows = await db
    .updateTable('Image')
    .set({ needsReview: null })
    .where('userId', '=', userId)
    .where('needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
    .where('ingestion', '=', 'Blocked')
    .where(sql<boolean>`NOT ${anyHold(sql<number>`${userId}::int`, marker)}`)
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
      const marker = await holdMarkerState(trx);
      const held = (await getFlagClearHolds([userId], trx)).get(userId);
      if (held) {
        console.warn('[csam-flag-clear] refused', { userId, moderatorId, held });
        return { ok: false, reason: 'held' } as const;
      }
      const cleared = await clearRemovedFlagsUnlessHeld(trx, userId, marker);
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
