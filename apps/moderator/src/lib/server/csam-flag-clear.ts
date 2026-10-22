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

/**
 * Whether `notes` match, case-insensitively, the pattern deployed in `MOD_HOLD_BAN_NOTES_PATTERN`.
 * Unset or empty matches everything, so every "Other" ban holds until the pattern is configured.
 * It is a Postgres regex: word boundaries are `\m` (start), `\M` (end) and `\y` (either), never
 * `\b`, which Postgres reads as a backspace.
 */
function banNotesMatchSql(notes: RawBuilder<string>) {
  const deployed = env.MOD_HOLD_BAN_NOTES_PATTERN;
  return deployed ? sql<boolean>`${notes} ~* ${deployed}` : sql<boolean>`true`;
}

/**
 * For a statement built when neither marker object existed: held if either exists by the time it
 * runs, since the marker leg it would need is not in it.
 */
const markerAppearedSql = () =>
  sql<boolean>`(to_regclass(${`"${HOLD_MARKER_VIEW}"`}) IS NOT NULL
               OR to_regclass(${`"${HOLD_MARKER_TABLE}"`}) IS NOT NULL)`;

/** Each reason a user's review flags may not be cleared in bulk, as a boolean over `userId`. */
export function flagClearHoldLegs(userId: RawBuilder<number>, marker: HoldMarkerState) {
  const reasonCode = sql`u.meta #>> '{banDetails,reasonCode}'`;
  const legs = {
    csamReport: sql<boolean>`EXISTS (SELECT 1 FROM "CsamReport" c WHERE c."userId" = ${userId})`,
    csamReportSecondary: sql<boolean>`EXISTS (
      SELECT 1 FROM "CsamReport" c
      WHERE CASE WHEN (c."details" ->> 'secondaryUserId') ~ '^[0-9]{1,18}$'
                 THEN (c."details" ->> 'secondaryUserId')::bigint END = ${userId}
    )`,
    ban: sql<boolean>`EXISTS (
      SELECT 1 FROM "User" u
      WHERE u.id = ${userId} AND u."bannedAt" IS NOT NULL
        AND (
          ${reasonCode} IS NULL
          OR ${reasonCode} IN (${sql.join([...BAN_REASONS_ALWAYS_REMOVING_MEDIA])})
          OR (${reasonCode} = 'Other' AND ${banNotesMatchSql(sql`concat_ws(' ',
                u.meta #>> '{banDetails,detailsInternal}',
                u.meta #>> '{banDetails,detailsExternal}')`)})
        )
    )`,
    // Any image the clear would touch that a report lists, whoever the report names, sent or
    // archived or not. Walks the reports' image lists rather than the user's images: the lists are
    // short, an account's images are not. Compared as bigint so an id past int range still matches.
    reportedImage: sql<boolean>`EXISTS (
      SELECT 1
      FROM "CsamReport" rc
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(rc."images") = 'array' THEN rc."images" ELSE '[]'::jsonb END
      ) re
      JOIN "Image" ri
        ON ri.id = CASE WHEN (re ->> 'id') ~ '^[0-9]{1,18}$' THEN (re ->> 'id')::bigint END
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
        : markerAppearedSql(),
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

function anyHold(
  userId: RawBuilder<number>,
  marker: HoldMarkerState,
  overriding: readonly FlagClearHoldLeg[] = []
) {
  const legs = Object.entries(flagClearHoldLegs(userId, marker))
    .filter(([name]) => !overriding.includes(name as FlagClearHoldLeg))
    .map(([, leg]) => leg);
  return sql<boolean>`(${sql.join(legs, sql` OR `)})`;
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
 *  would clear, unless the user is held by a leg other than `overriding`. The hold is repeated in the
 *  UPDATE so the check and the write are one statement. Returns the cleared image ids. */
export async function clearRemovedFlagsUnlessHeld(
  db: Kysely<DB>,
  userId: number,
  marker: HoldMarkerState,
  overriding: readonly FlagClearHoldLeg[] = []
): Promise<number[]> {
  const rows = await db
    .updateTable('Image')
    .set({ needsReview: null })
    .where('userId', '=', userId)
    .where('needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
    .where('ingestion', '=', 'Blocked')
    .where(sql<boolean>`NOT ${anyHold(sql<number>`${userId}::int`, marker, overriding)}`)
    .returning('id')
    .execute();
  return rows.map((r) => r.id);
}

export type ClearUserFlagsResult =
  | { ok: true; cleared: number; remaining: number }
  | { ok: false; reason: 'held' | 'changed' };

class QueueChanged extends Error {}

async function flaggedCount(db: Kysely<DB>, userId: number): Promise<number> {
  const row = await db
    .selectFrom('Image')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('userId', '=', userId)
    .where('needsReview', '=', FLAG_KEPT_THROUGH_BLOCK)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

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
      const remaining = await flaggedCount(trx, userId);
      return { ok: true, cleared: cleared.length, remaining } as const;
    });
  } catch (e) {
    if (e instanceof QueueChanged) return { ok: false, reason: 'changed' };
    throw e;
  }
}

/** The only leg an admin release may override. A report or an evidence hold is Legal's, never ours. */
export const RELEASABLE_LEGS: readonly FlagClearHoldLeg[] = ['ban'];

export const RELEASE_TABLE = 'CsamFlagRelease';

/** The shape of an approval reference: `YYYY-MM-DD-HHMMSS-` and eight hex digits. */
export const APPROVAL_REF_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-f]{8}$/;

export type ReleaseHeldFlagsResult =
  | { ok: true; dryRun: boolean; count: number; remaining: number; legs: FlagClearHoldLeg[] }
  | {
      ok: false;
      reason: 'not-held' | 'held' | 'changed' | 'unavailable';
      legs: FlagClearHoldLeg[];
    };

class DryRun extends Error {
  constructor(readonly count: number, readonly remaining: number) {
    super('dry run');
  }
}

/**
 * `clearUserCsamFlags` for a user held ONLY by `RELEASABLE_LEGS`, under an approval. Every other leg
 * still refuses, in the pre-check and again in the UPDATE. Writes one `CsamFlagRelease` row and a
 * `releaseHeldReviewFlag` ModActivity row per image, in the same transaction. A dry run makes the same
 * update and rolls it back, so its count is exactly what the release would clear.
 */
export async function releaseHeldUserCsamFlags(
  input: {
    userId: number;
    approvalRef: string;
    reason: string;
    moderatorId: number;
  } & ({ dryRun: true } | { dryRun?: false; expectedCount: number })
): Promise<ReleaseHeldFlagsResult> {
  const { userId, approvalRef, moderatorId } = input;
  const reason = input.reason.trim();
  if (!APPROVAL_REF_PATTERN.test(approvalRef)) throw new Error('Not an approval reference.');
  if (!reason) throw new Error('A release needs a reason.');
  let legs: FlagClearHoldLeg[] = [];
  try {
    return await dbWrite.transaction().execute(async (trx) => {
      const { rows } = await sql<{ present: unknown }>`
        SELECT to_regclass(${`"${RELEASE_TABLE}"`}) IS NOT NULL AS present`.execute(trx);
      if (rows[0]?.present !== true) return { ok: false, reason: 'unavailable', legs } as const;

      const marker = await holdMarkerState(trx);
      legs = (await getFlagClearHolds([userId], trx)).get(userId) ?? [];
      if (!legs.length) return { ok: false, reason: 'not-held', legs } as const;
      if (legs.some((leg) => !RELEASABLE_LEGS.includes(leg))) {
        console.warn('[csam-flag-clear] release refused', { userId, moderatorId, legs });
        return { ok: false, reason: 'held', legs } as const;
      }

      const released = await clearRemovedFlagsUnlessHeld(trx, userId, marker, RELEASABLE_LEGS);
      const remaining = await flaggedCount(trx, userId);
      if (input.dryRun) throw new DryRun(released.length, remaining);
      if (released.length !== input.expectedCount) throw new QueueChanged();

      await trx
        .insertInto('CsamFlagRelease')
        .values({
          userId,
          moderatorId,
          approvalRef,
          reason,
          overriddenLegs: JSON.stringify(legs),
          imageCount: released.length,
        })
        .execute();
      await insertModActivityBatch(trx, {
        userId: moderatorId,
        entityType: 'image',
        entityIds: released,
        activity: 'releaseHeldReviewFlag',
      });
      return { ok: true, dryRun: false, count: released.length, remaining, legs } as const;
    });
  } catch (e) {
    if (e instanceof DryRun)
      return { ok: true, dryRun: true, count: e.count, remaining: e.remaining, legs };
    if (e instanceof QueueChanged) return { ok: false, reason: 'changed', legs };
    throw e;
  }
}
