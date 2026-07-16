import { getClickhouse } from '$lib/server/clickhouse';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';

// Content/Creator analytics (B4 section b). Every metric is keyed **directly to the creator's userId** in
// ClickHouse — no owner-keyed rollup (A1) needed. Daily/weekly counts over a rolling window, gap-filled so the
// charts are continuous. Model-usage/earnings metrics (keyed by modelVersionId) wait on A1 and are not here.

export type TimePoint = { date: string; value: number };
// `url` is the Cloudflare media path (EdgeMedia builds the thumbnail URL); `type` is image|video; `nsfwLevel` is
// the bitwise level (blur mature + route to civitai.red). From a Postgres lookup by imageId — deleted images (no
// row) are dropped server-side, so every entry here is a live image.
export type TopImage = {
  imageId: number;
  reactions: number;
  url: string;
  nsfwLevel: number;
  type: 'image' | 'video' | 'audio';
};
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

// All-time reactions + comments on the creator's images, from the per-creator `image_metrics_user` rollup (a cheap
// point lookup — comments have no fast period-scoped source, so this is the one place we surface them).
export type AllTimeTotals = { reactions: number; comments: number };

// Analytics reads are cached in Redis so page reloads hit the cache, not ClickHouse (fail-open). Wider windows
// are both more expensive to compute (the 90-day query is slow) and less volatile (an extra hour barely moves a
// 90-day total), so they cache longer; the cheap, freshness-sensitive 7-day window caches briefly.
const rangeTtlSeconds = (days: number) => (days >= 90 ? 3600 : days >= 30 ? 900 : 300);

// Cached read-through wrappers. The named args double as the cache key; the TTL reads `days` off the same args.
export const getContentAnalytics = createCache({
  name: 'analytics:content',
  fetch: ({ userId, days, granularity }: { userId: number; days: number; granularity: Granularity }) =>
    fetchContentAnalytics(userId, days, granularity),
  ttlSeconds: ({ days }) => rangeTtlSeconds(days),
}).get;

export const getContentTotals = createCache({
  name: 'analytics:totals',
  fetch: ({ userId, days }: { userId: number; days: number }) => fetchContentTotals(userId, days),
  ttlSeconds: ({ days }) => rangeTtlSeconds(days),
}).get;

export const getAllTimeTotals = createCache({
  name: 'analytics:alltime',
  fetch: async ({ userId }: { userId: number }): Promise<AllTimeTotals> => {
    const uid = Number(userId);
    const rows = await getClickhouse().$query<{ reactions: number | string; comments: number | string }>(
      `SELECT sumMerge(reactions) AS reactions, sumMerge(comments) AS comments FROM image_metrics_user WHERE userId = ${uid}`
    );
    return { reactions: Number(rows[0]?.reactions ?? 0), comments: Number(rows[0]?.comments ?? 0) };
  },
  ttlSeconds: 3600,
}).get;

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

async function fetchContentAnalytics(
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
    topImages: await enrichTopImages(topImagesRaw),
  };
}

// Look up the CF url + nsfwLevel for the top images (Postgres, by primary key) so the analytics grid can show real
// thumbnails instead of bare IDs. Order is preserved from the ClickHouse ranking.
async function enrichTopImages(
  raw: { imageId: number | string; reactions: number | string }[]
): Promise<TopImage[]> {
  const ids = raw.map((r) => Number(r.imageId));
  const rows = ids.length
    ? await dbRead
        .selectFrom('Image')
        .where('id', 'in', ids)
        .select(['id', 'url', 'nsfwLevel', 'type'])
        .execute()
    : [];
  const byId = new Map(rows.map((i) => [i.id, i]));
  // Drop deleted images (no Image row / no url) — we don't surface them in the grid.
  return raw
    .map((r): TopImage | null => {
      const img = byId.get(Number(r.imageId));
      if (!img?.url) return null;
      return {
        imageId: Number(r.imageId),
        reactions: Number(r.reactions),
        url: img.url,
        nsfwLevel: Number(img.nsfwLevel ?? 0),
        type: img.type as 'image' | 'video' | 'audio',
      };
    })
    .filter((x): x is TopImage => x !== null);
}

// Just the period totals (no series / top-images) — cheap enough for the dashboard's activity row.
async function fetchContentTotals(userId: number, days: number): Promise<ContentTotals> {
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
