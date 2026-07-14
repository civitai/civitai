import { getClickhouse } from '$lib/server/clickhouse';

// Content/Creator analytics (B4 section b). Every metric is keyed **directly to the creator's userId** in
// ClickHouse — no owner-keyed rollup (A1) needed. Daily/weekly counts over a rolling window, gap-filled so the
// charts are continuous. Model-usage/earnings metrics (keyed by modelVersionId) wait on A1 and are not here.

export type TimePoint = { date: string; value: number };
export type TopImage = { imageId: number; reactions: number };
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
  topImages: TopImage[];
};

export const ANALYTICS_RANGES = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export type Granularity = 'day' | 'week';

// Gap-filled daily/weekly count query for `table`, keyed to the creator via `filter`. WITH FILL synthesizes the
// missing buckets (value 0) so a series never has holes; `TO … + step` makes the range inclusive of today/this
// week. userId + days are trusted integers (session id + validated preset), so they're interpolated directly.
function seriesSql(
  table: string,
  timeCol: string,
  filter: string,
  d: number,
  gran: Granularity
): string {
  const bucket = gran === 'week' ? `toStartOfWeek(${timeCol}, 1)` : `toDate(${timeCol})`;
  const from = gran === 'week' ? `toStartOfWeek(today() - ${d}, 1)` : `today() - ${d}`;
  const to = gran === 'week' ? `toStartOfWeek(today(), 1) + 7` : `today() + 1`;
  const step = gran === 'week' ? 7 : 1;
  return `SELECT ${bucket} AS date, count() AS value FROM ${table} WHERE ${filter} AND toDate(${timeCol}) >= today() - ${d} GROUP BY date ORDER BY date WITH FILL FROM ${from} TO ${to} STEP ${step}`;
}

export async function getContentAnalytics(
  userId: number,
  days: number,
  granularity: Granularity
): Promise<ContentAnalytics> {
  const uid = Number(userId);
  const d = Number(days);
  const g = granularity;
  const ch = getClickhouse();

  const series = async (sql: string): Promise<TimePoint[]> => {
    const rows = await ch.$query<{ date: string; value: number | string }>(sql);
    return rows.map((r) => ({ date: String(r.date), value: Number(r.value) }));
  };

  const [reactions, followers, images, posts, profileViews, topImagesRaw] = await Promise.all([
    series(
      seriesSql(
        'reactions',
        'time',
        `ownerId = ${uid} AND endsWith(toString(type), '_Create')`,
        d,
        g
      )
    ),
    series(seriesSql('userEngagements', 'time', `targetUserId = ${uid} AND type = 'Follow'`, d, g)),
    series(seriesSql('images_created', 'createdAt', `userId = ${uid}`, d, g)),
    series(seriesSql('posts', 'time', `userId = ${uid} AND type = 'Publish'`, d, g)),
    series(seriesSql('views', 'time', `entityType = 'User' AND entityId = ${uid}`, d, g)),
    ch.$query<{ imageId: number | string; reactions: number | string }>(
      `SELECT entityId AS imageId, count() AS reactions FROM reactions WHERE ownerId = ${uid} AND type = 'Image_Create' AND toDate(time) >= today() - ${d} GROUP BY imageId ORDER BY reactions DESC LIMIT 10`
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
    topImages: topImagesRaw.map((r) => ({
      imageId: Number(r.imageId),
      reactions: Number(r.reactions),
    })),
  };
}

// Just the period totals (no series / top-images) — cheap enough for the dashboard's activity row.
export async function getContentTotals(userId: number, days: number): Promise<ContentTotals> {
  const uid = Number(userId);
  const d = Number(days);
  const ch = getClickhouse();

  const count = async (table: string, timeCol: string, filter: string): Promise<number> => {
    const rows = await ch.$query<{ value: number | string }>(
      `SELECT count() AS value FROM ${table} WHERE ${filter} AND toDate(${timeCol}) >= today() - ${d}`
    );
    return Number(rows[0]?.value ?? 0);
  };

  const [reactions, followers, images, posts, profileViews] = await Promise.all([
    count('reactions', 'time', `ownerId = ${uid} AND endsWith(toString(type), '_Create')`),
    count('userEngagements', 'time', `targetUserId = ${uid} AND type = 'Follow'`),
    count('images_created', 'createdAt', `userId = ${uid}`),
    count('posts', 'time', `userId = ${uid} AND type = 'Publish'`),
    count('views', 'time', `entityType = 'User' AND entityId = ${uid}`),
  ]);

  return { reactions, followers, images, posts, profileViews };
}
