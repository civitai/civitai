import { dbRead } from '$lib/server/db';
import { getClickhouse } from '$lib/server/clickhouse';
import { createCache } from '$lib/server/cache';
import { IMPRESSION_ENTITY } from '$lib/server/view-entities';
import { entityImpressionTotalsSql } from '$lib/server/analytics-sql';

// Pruning floor for the `actions` reads below, and deliberately EARLIER than the date creators are
// shown. `actions` is ORDER BY (time, type), so a type filter alone reads all 92.8M rows and only a
// `time` bound touches the primary key. It must be <= the first possible row and is otherwise free
// to be conservative: no row of these types can predate the deploy. Server-only — it has no meaning
// in a browser, and keeping it out of `$lib/impressions.ts` keeps two similar-looking dates from
// sitting next to each other where one of them would read as the start of counting.
const ACTIONS_FLOOR = '2026-08-28';

export type AnnouncementMetrics = {
  /** Per announcement id. A missing id means no rows, which is a real zero — both reads are all-time. */
  impressions: Record<number, number>;
  clicks: Record<number, number>;
  /** How many people mute this creator's announcements right now. Postgres, so retroactive and exact. */
  mutedNow: number;
  /** Followers, i.e. who a non-profile-only announcement can reach before mutes are subtracted. */
  followers: number;
};

// Ten minutes: these are read on every load of a page the creator also composes on, so a save
// or a delete re-runs the load. `mutedNow` stays outside the cache — it is the one figure a
// creator can change by asking someone, and it is a single indexed count.
const announcementClickhouse = createCache({
  name: 'announcement-metrics',
  ttlSeconds: 600,
  fetch: ({ userId, ids }: { userId: number; ids: string }) => readClickhouse(userId, ids),
});

/**
 * Reach, click-through and mutes for a creator's own announcements.
 *
 * Reads what the platform already writes: `daily_impressions` for reach, `actions` for the
 * link click and the mute events. Nothing announcement-specific is stored.
 *
 * The two halves are not equally trustworthy and the difference matters if this is ever used
 * for more than showing a creator their own numbers: impressions arrive from the browser on
 * an unauthenticated beacon, while mute events are written server-side from the mutation that
 * performs the mute.
 */
export async function getAnnouncementMetrics(
  userId: number,
  announcementIds: number[]
): Promise<AnnouncementMetrics> {
  const [mutedNow, followers, clickhouse] = await Promise.all([
    countMutes(userId),
    countFollowers(userId),
    announcementClickhouse.get({ userId, ids: announcementIds.join(',') }),
  ]);

  return { ...clickhouse, mutedNow, followers };
}

async function countMutes(userId: number): Promise<number> {
  const row = await dbRead
    .selectFrom('UserAnnouncementMute')
    .where('creatorId', '=', userId)
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .executeTakeFirst();

  return Number(row?.count ?? 0);
}

/**
 * `UserMetric` rather than counting `UserEngagement`: that table is keyed `(userId, targetUserId)`
 * and indexed `(type, userId)`, so counting a creator's FOLLOWERS — the target side — matches no
 * index. The rollup is a primary-key lookup.
 */
async function countFollowers(userId: number): Promise<number> {
  const row = await dbRead
    .selectFrom('UserMetric')
    .where('userId', '=', userId)
    .where('timeframe', '=', 'AllTime')
    .select('followerCount')
    .executeTakeFirst();

  return Number(row?.followerCount ?? 0);
}

async function readClickhouse(
  userId: number,
  idList: string
): Promise<Omit<AnnouncementMetrics, 'mutedNow' | 'followers'>> {
  const ch = getClickhouse();

  const [impressionRows, clickRows] = await Promise.all([
    idList
      ? ch.$query<{ id: number | string; impressions: number | string }>(
          entityImpressionTotalsSql(IMPRESSION_ENTITY.announcement, idList)
        )
      : [],
    idList
      ? ch.$query<{ id: number | string; clicks: number | string }>(
          // 🔴 `time >= …` is the only predicate that prunes. `actions` is ORDER BY (time, type),
          // so a `type` filter alone reads every one of its 92.8M rows (measured: 11,157 of 11,157
          // marks, ~900ms) and gets worse by ~215M rows a year. The floor is the day the feature
          // shipped, and no row of these types can predate it.
          `SELECT JSONExtractUInt(details, 'announcementId') AS id, count() AS clicks FROM actions
           WHERE time >= toDate('${ACTIONS_FLOOR}')
             AND type = 'Announcement_Click'
             AND JSONExtractUInt(details, 'creatorId') = ${userId}
             AND id IN (${idList})
           GROUP BY id`
        )
      : [],
  ]);

  return {
    impressions: Object.fromEntries(
      impressionRows.map((r) => [Number(r.id), Number(r.impressions)])
    ),
    clicks: Object.fromEntries(clickRows.map((r) => [Number(r.id), Number(r.clicks)])),
  };
}
