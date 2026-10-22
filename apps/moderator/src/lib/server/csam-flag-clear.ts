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

const FALLBACK_BAN_NOTES_TERMS = ['csam', 'ncmec', 'minor'];
export const FALLBACK_BAN_NOTES_PATTERN = `(${FALLBACK_BAN_NOTES_TERMS.join('|')})`;

/** Whether `pattern` still matches every fallback term. Checked in Postgres: it is a Postgres regex. */
const coversFallback = (pattern: string) =>
  sql<boolean>`(${sql.join(
    FALLBACK_BAN_NOTES_TERMS.map((term) => sql`${term} ~* ${pattern}`),
    sql` AND `
  )})`;

/**
 * Whether `notes` match, case-insensitively, the fallback or the pattern deployed in
 * `MOD_HOLD_BAN_NOTES_PATTERN`. The deployed pattern can only widen the match, never narrow it.
 * It is a Postgres regex: word boundaries are `\m` (start), `\M` (end) and `\y` (either), never
 * `\b`, which Postgres reads as a backspace.
 */
function banNotesMatchSql(notes: RawBuilder<string>) {
  const deployed = env.MOD_HOLD_BAN_NOTES_PATTERN;
  const fallback = sql<boolean>`${notes} ~* ${FALLBACK_BAN_NOTES_PATTERN}`;
  return deployed ? sql<boolean>`(${fallback} OR ${notes} ~* ${deployed})` : fallback;
}

let reportedPattern: string | undefined;

/** Logs, once per pattern, a deployed pattern that misses a fallback term, which is likely a mistake. */
async function checkDeployedBanNotesPattern(db: Kysely<DB>) {
  const deployed = env.MOD_HOLD_BAN_NOTES_PATTERN;
  if (!deployed || deployed === reportedPattern) return;
  const { rows } = await sql<{ ok: unknown }>`SELECT ${coversFallback(deployed)} AS ok`.execute(db);
  reportedPattern = deployed;
  if (rows[0]?.ok !== true)
    console.error(
      '[csam-flag-clear] MOD_HOLD_BAN_NOTES_PATTERN misses a fallback term; the fallback still applies'
    );
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

export async function holdMarkerState(db: Kysely<DB>): Promise<HoldMarkerState> {
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
  await checkDeployedBanNotesPattern(db).catch((e) =>
    console.error('[csam-flag-clear] ban-notes pattern check failed', e)
  );
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
