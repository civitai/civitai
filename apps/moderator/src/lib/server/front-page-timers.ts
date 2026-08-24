import { getModeratorDb } from './moderator-db';
import type { SweepMedia } from './front-page-audit.service';

/**
 * `FrontPageTimers` and `FrontPageTimers_catchup` — the front-page sweep's shared resume points.
 *
 * Both halves live here because a fork row and a moderator's mark share one table and are read together.
 */

/** Not a person: the row the Split control writes to mark where the queue was forked. */
export const SPLIT_USERNAME = 'splitQueue';

/**
 * A resume point belongs to one rating AND one media type. The table has no media column — Retool ran
 * one sweep and keyed on the rating alone — so the video stream is namespaced into the same free-text
 * `nsfw` column instead of migrating the table.
 *
 * Images keep the bare rating, which is what Retool's own app and every existing row already use, so
 * nothing that reads them has to change. Video gets its own key, which is what stops the 20-row video
 * sweep from advancing the point the 200-row image sweep resumes from: same rating, same span, a
 * population nobody looked at.
 *
 * `splitFrontPageQueue` writes and reads the bare `'1'` deliberately — the fork it marks is the image
 * firehose `ImageSfwDataCatchup` consumes, and video has never been part of that stream.
 */
const checkpointKey = (nsfwLevel: number, media: SweepMedia) =>
  media === 'video' ? `video:${nsfwLevel}` : String(nsfwLevel);

/** Retool's `GetSplitQueue`: where the queue was last forked. */
export async function getSplitPoint(): Promise<Date | null> {
  const row = await getModeratorDb()
    .selectFrom('FrontPageTimers')
    .select('lastCheckedAt')
    .where('username', '=', SPLIT_USERNAME)
    .orderBy('lastCheckedAt', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.lastCheckedAt ? new Date(row.lastCheckedAt as unknown as string) : null;
}

/**
 * The two tables get DIFFERENT resume points, and getting this wrong drops the backlog silently.
 *
 * - `FrontPageTimers` (current stream) → `now - 3h`, the fork point. Retool's offset: placed slightly
 *   in the past so images uploaded around the split are caught by one stream rather than missed by both.
 * - `FrontPageTimers_catchup` → **where the sweep actually is now**: the newest `nsfw = '1'` row
 *   already in `FrontPageTimers`. Retool read this from `TagTimer` and filtered to level 1.
 *
 * The catch-up consumer (`ImageSfwDataCatchup`) reads
 * `createdAt > <catchup resume> AND createdAt < <fork point>`. Writing the fork point into BOTH makes
 * those bounds equal, so the catch-up window is empty and everything between the real checkpoint and
 * the fork — the backlog that justified pressing the button — is worked by neither stream.
 *
 * No attribution: `username` is the sentinel identifying the fork row, so the table has nowhere to
 * record who pressed it. The ModActivity row the caller writes is the audit trail.
 */
export async function splitFrontPageQueue(): Promise<{
  at: Date;
  catchupFrom: Date | null;
  /** The new fork row. `recordModActivity` de-duplicates on (activity, entityType, entityId), so a
   *  constant id there records the FIRST split ever and silently drops every one after it. */
  forkId: number;
}> {
  const at = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const db = getModeratorDb();

  // NO username filter — Retool's `TagTimer` has none, and the sentinel row IS a position write for
  // the current stream. Excluding it was only equivalent on the first split ever: on the second it
  // resurrected a checkpoint the previous catch-up run had already worked, re-opening that window.
  const current = await db
    .selectFrom('FrontPageTimers')
    .select('lastCheckedAt')
    .where('nsfw', '=', '1')
    .orderBy('lastCheckedAt', 'desc')
    .limit(1)
    .executeTakeFirst();
  const catchupFrom = current?.lastCheckedAt
    ? new Date(current.lastCheckedAt as unknown as string)
    : null;

  const base = { username: SPLIT_USERNAME, nsfw: '1', buttonPressedTime: at };

  // Both or neither: one table forked and the other not is a queue that silently skips a window.
  let forkId = 0;
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('FrontPageTimers')
      .values({ ...base, lastCheckedAt: at })
      .returning('id')
      .executeTakeFirst()
      .then((r) => {
        forkId = r?.id ?? 0;
      });
    await trx
      .insertInto('FrontPageTimers_catchup')
      // No prior checkpoint means no backlog to catch up on, so the catch-up stream starts at the fork.
      .values({ ...base, lastCheckedAt: catchupFrom ?? at })
      .execute();
  });

  return { at, catchupFrom, forkId };
}

export type SweepCheckpoint = {
  lastCheckedAt: Date;
  username: string | null;
  buttonPressedTime: Date | null;
  /** The row is the Split control's fork marker, not a moderator's mark. `username` holds a sentinel
   *  on those, so a caller rendering it as a person shows `splitQueue` where a name belongs. */
  isSplit: boolean;
};

/**
 * The SHARED resume point for a sweep, per rating (Retool's `Timestamp` / `LogTimestamp`).
 *
 * `/retool/queue-stats` has been writing these rows all along — its Split control forks
 * `FrontPageTimers` and `FrontPageTimers_catchup` and tells the moderator a fork happened — while this
 * page read neither and windowed on a fixed `hours` dropdown instead. So Split changed nothing any
 * moderator could see, and the two pages said contradictory things about the same mechanism.
 *
 * `nsfw` is Retool's column and holds the rating as text.
 */
/**
 * One point per rating, for the ratings asked about. A sweep can cover several at once and they are
 * NOT interchangeable: each rating is drained at its own pace, so collapsing them to one point would
 * either re-show work or skip it.
 */
export async function getSweepCheckpoints(
  nsfwLevels: number[],
  media: SweepMedia
): Promise<Map<number, SweepCheckpoint>> {
  if (!nsfwLevels.length) return new Map();
  const levelByKey = new Map(nsfwLevels.map((l) => [checkpointKey(l, media), l]));

  const rows = await getModeratorDb()
    .selectFrom('FrontPageTimers')
    .select(['nsfw', 'lastCheckedAt', 'username', 'buttonPressedTime'])
    .where('nsfw', 'in', [...levelByKey.keys()])
    .orderBy('lastCheckedAt', 'desc')
    .execute();

  // Newest row per key wins; the rest are that rating's history.
  const out = new Map<number, SweepCheckpoint>();
  for (const row of rows) {
    const level = row.nsfw == null ? undefined : levelByKey.get(row.nsfw);
    if (level === undefined || out.has(level) || !row.lastCheckedAt) continue;
    out.set(level, {
      lastCheckedAt: new Date(row.lastCheckedAt as unknown as string),
      username: row.username,
      buttonPressedTime: row.buttonPressedTime
        ? new Date(row.buttonPressedTime as unknown as string)
        : null,
      isSplit: row.username === SPLIT_USERNAME,
    });
  }
  return out;
}

export async function getSweepCheckpoint(
  nsfwLevel: number,
  media: SweepMedia
): Promise<SweepCheckpoint | null> {
  // Deliberately NOT filtered by username, matching `getSplitPoint`: the Split control's sentinel row
  // is itself a position write for the current stream, so excluding it would resurrect a checkpoint the
  // previous catch-up run had already worked. It does mean the newest row can be the fork rather than a
  // person's mark — `isSplit` is how the caller tells them apart.
  const row = await getModeratorDb()
    .selectFrom('FrontPageTimers')
    .select(['lastCheckedAt', 'username', 'buttonPressedTime'])
    .where('nsfw', '=', checkpointKey(nsfwLevel, media))
    .orderBy('lastCheckedAt', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row?.lastCheckedAt) return null;

  return {
    lastCheckedAt: new Date(row.lastCheckedAt as unknown as string),
    username: row.username,
    buttonPressedTime: row.buttonPressedTime
      ? new Date(row.buttonPressedTime as unknown as string)
      : null,
    isSplit: row.username === SPLIT_USERNAME,
  };
}

/**
 * Advance the shared resume point to the last image the moderator actually looked at — Retool's green
 * "Log" button, whose changeset the raw export carries in full.
 *
 * `lastCheckedAt` is the `createdAt` of the LAST row of the page just swept, not `now()`: the sweep is
 * ordered oldest-first within its window, so anything created while the moderator worked has not been
 * looked at and must stay in the next window.
 *
 * Retool disabled this on the Reaction ordering, which is not a queue to drain and has no meaningful
 * "up to here" — the caller enforces that.
 */
export async function markSweepChecked(input: {
  nsfwLevel: number;
  media: SweepMedia;
  lastCheckedAt: Date;
  username: string;
}): Promise<void> {
  await getModeratorDb()
    .insertInto('FrontPageTimers')
    .values({
      username: input.username,
      nsfw: checkpointKey(input.nsfwLevel, input.media),
      lastCheckedAt: input.lastCheckedAt,
      buttonPressedTime: new Date(),
    })
    .execute();
}
