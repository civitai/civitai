import { getClickhouse } from '$lib/server/clickhouse';

// Content/Creator analytics (B4 section b). Every metric is keyed **directly to the creator's userId** in
// ClickHouse — no owner-keyed rollup (A1) needed. Daily counts over a rolling window. Model-usage/earnings
// metrics (keyed by modelVersionId) are the ones that wait on A1 and are not here.

export type TimePoint = { date: string; value: number };
export type ContentTotals = {
  reactions: number;
  followers: number;
  images: number;
  posts: number;
  profileViews: number;
};
export type ContentAnalytics = {
  reactions: TimePoint[];
  followers: TimePoint[];
  images: TimePoint[];
  posts: TimePoint[];
  profileViews: TimePoint[];
  totals: ContentTotals;
};

export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

// userId + days are trusted integers (session id + a validated preset), so they're coerced and interpolated
// directly rather than going through the tagged-template formatter.
export async function getContentAnalytics(userId: number, days: number): Promise<ContentAnalytics> {
  const uid = Number(userId);
  const d = Number(days);
  const ch = getClickhouse();

  const series = async (sql: string): Promise<TimePoint[]> => {
    const rows = await ch.$query<{ date: string; value: number | string }>(sql);
    return rows.map((r) => ({ date: String(r.date), value: Number(r.value) }));
  };

  const [reactions, followers, images, posts, profileViews] = await Promise.all([
    series(
      `SELECT toDate(time) AS date, count() AS value FROM reactions WHERE ownerId = ${uid} AND endsWith(toString(type), '_Create') AND toDate(time) >= today() - ${d} GROUP BY date ORDER BY date`
    ),
    series(
      `SELECT toDate(time) AS date, count() AS value FROM userEngagements WHERE targetUserId = ${uid} AND type = 'Follow' AND toDate(time) >= today() - ${d} GROUP BY date ORDER BY date`
    ),
    series(
      `SELECT toDate(createdAt) AS date, count() AS value FROM images_created WHERE userId = ${uid} AND toDate(createdAt) >= today() - ${d} GROUP BY date ORDER BY date`
    ),
    series(
      `SELECT toDate(time) AS date, count() AS value FROM posts WHERE userId = ${uid} AND type = 'Publish' AND toDate(time) >= today() - ${d} GROUP BY date ORDER BY date`
    ),
    series(
      `SELECT toDate(time) AS date, count() AS value FROM views WHERE entityType = 'User' AND entityId = ${uid} AND toDate(time) >= today() - ${d} GROUP BY date ORDER BY date`
    ),
  ]);

  const sum = (s: TimePoint[]) => s.reduce((acc, p) => acc + p.value, 0);
  return {
    reactions,
    followers,
    images,
    posts,
    profileViews,
    totals: {
      reactions: sum(reactions),
      followers: sum(followers),
      images: sum(images),
      posts: sum(posts),
      profileViews: sum(profileViews),
    },
  };
}
