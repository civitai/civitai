import { getClickhouse } from '$lib/server/clickhouse';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { rangeTtlSeconds } from '$lib/date-range';

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
};

// All-time reactions + comments on the creator's content. Reactions come from `reactions_owner_scores` (the same
// owner-keyed rollup behind `UserMetric.reactionCount`, so this tile agrees with the creator's profile). Comments are
// still the `image_metrics_user` backfill, which nothing writes any more — see the note on the fetch below.
export type AllTimeTotals = { reactions: number; comments: number };

// Cached read-through wrappers. The named args double as the cache key; the TTL scales with the range span
// (span-based, capped at 30 min) so reloads/back-nav hit Redis, not ClickHouse (fail-open).
export const getContentAnalytics = createCache({
  name: 'analytics:content',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchContentAnalytics(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

export const getContentTotals = createCache({
  name: 'analytics:totals',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchContentTotals(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

// Top reacted media over the range (images + videos, split by `type` on each page).
export const getTopMedia = createCache({
  name: 'analytics:top-media',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchTopMedia(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

export const getAllTimeTotals = createCache({
  name: 'analytics:alltime',
  fetch: async ({ userId }: { userId: number }): Promise<AllTimeTotals> => {
    const uid = Number(userId);
    const ch = getClickhouse();
    // `image_metrics_user` is a dead one-off backfill — nothing writes it and its max userId is 9.66M against
    // current ids past 12.5M, so this comments number is frozen and reads 0 for newer creators. Needs a real source.
    const [reactionRows, commentRows] = await Promise.all([
      ch.$query<{ reactions: number | string }>(
        `SELECT sum(score) AS reactions FROM reactions_owner_scores WHERE ownerId = ${uid}`
      ),
      ch.$query<{ comments: number | string }>(
        `SELECT sumMerge(comments) AS comments FROM image_metrics_user WHERE userId = ${uid}`
      ),
    ]);
    return {
      reactions: Number(reactionRows[0]?.reactions ?? 0),
      comments: Number(commentRows[0]?.comments ?? 0),
    };
  },
  ttlSeconds: 3600,
}).get;

// Gap-filled daily count query for `table`, keyed to the creator via `filter`. WITH FILL synthesizes the missing
// buckets (value 0) so a series never has holes; the `TO … + 1` upper bound is inclusive of the `to` day. userId
// is the trusted session id and from/to are validated ISO dates (parseRange), so all are interpolated directly.
function seriesSql(
  table: string,
  timeCol: string,
  filter: string,
  from: string,
  to: string
): string {
  return `SELECT toDate(${timeCol}) AS date, count() AS value FROM ${table} WHERE ${filter} AND toDate(${timeCol}) >= toDate('${from}') AND toDate(${timeCol}) <= toDate('${to}') GROUP BY date ORDER BY date WITH FILL FROM toDate('${from}') TO toDate('${to}') + 1 STEP 1`;
}

// `reactions` is append-only: un-reacting writes a `<Entity>_Delete` row rather than removing the `_Create`, so a
// count filtered to `_Create` makes every react/un-react cycle a permanent +1. Must stay unclamped — clamping a
// negative bucket makes the period total depend on bucket width. Kept in sync with `reactions_owner_scores_mv`; a
// new entity type in the `type` enum has to be added to both or it counts as a delete here.
const reactionCreateTypes = `('Image_Create', 'Comment_Create', 'CommentV2_Create', 'Review_Create', 'Question_Create', 'Answer_Create', 'BountyEntry_Create', 'Article_Create')`;
const netReactions = `sum(if(type IN ${reactionCreateTypes}, 1, -1))`;

function netReactionsDailySql(uid: number, from: string, to: string): string {
  return `SELECT toDate(time) AS date, ${netReactions} AS value FROM reactions WHERE ownerId = ${uid} AND toDate(time) >= toDate('${from}') AND toDate(time) <= toDate('${to}') GROUP BY date`;
}

async function fetchContentAnalytics(
  userId: number,
  from: string,
  to: string
): Promise<ContentAnalytics> {
  const uid = Number(userId);
  const ch = getClickhouse();

  const series = async (sql: string): Promise<TimePoint[]> => {
    const rows = await ch.$query<{ date: string; value: number | string }>(sql);
    return rows.map((r) => ({ date: String(r.date), value: Number(r.value) }));
  };

  const [reactions, followers, images, posts, profileViews] = await Promise.all([
    series(
      `${netReactionsDailySql(
        uid,
        from,
        to
      )} ORDER BY date WITH FILL FROM toDate('${from}') TO toDate('${to}') + 1 STEP 1`
    ),
    series(
      seriesSql('userEngagements', 'time', `targetUserId = ${uid} AND type = 'Follow'`, from, to)
    ),
    series(seriesSql('images_created', 'createdAt', `userId = ${uid}`, from, to)),
    series(seriesSql('posts', 'time', `userId = ${uid} AND type = 'Publish'`, from, to)),
    series(seriesSql('views', 'time', `entityType = 'User' AND entityId = ${uid}`, from, to)),
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

// Top reacted media (images + videos) over the range — the /analytics/content tabs filter this by `type`. We rank
// the creator's most-reacted image-entities in ClickHouse, then enrich via Postgres (which is where the media type
// lives), so both tabs share one fetch. 100 gives each type a reasonable list.
async function fetchTopMedia(userId: number, from: string, to: string): Promise<TopImage[]> {
  const uid = Number(userId);
  const raw = await getClickhouse().$query<{
    imageId: number | string;
    reactions: number | string;
  }>(
    `SELECT entityId AS imageId, ${netReactions} AS reactions FROM reactions WHERE ownerId = ${uid} AND type IN ('Image_Create', 'Image_Delete') AND toDate(time) >= toDate('${from}') AND toDate(time) <= toDate('${to}') GROUP BY imageId HAVING reactions > 0 ORDER BY reactions DESC LIMIT 100`
  );
  return enrichTopImages(raw);
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
async function fetchContentTotals(
  userId: number,
  from: string,
  to: string
): Promise<ContentTotals> {
  const uid = Number(userId);
  const ch = getClickhouse();

  const count = async (table: string, timeCol: string, filter: string): Promise<number> => {
    const rows = await ch.$query<{ value: number | string }>(
      `SELECT count() AS value FROM ${table} WHERE ${filter} AND toDate(${timeCol}) >= toDate('${from}') AND toDate(${timeCol}) <= toDate('${to}')`
    );
    return Number(rows[0]?.value ?? 0);
  };

  const netReactionsTotal = async (): Promise<number> => {
    const rows = await ch.$query<{ value: number | string }>(
      `SELECT sum(value) AS value FROM (${netReactionsDailySql(uid, from, to)})`
    );
    return Number(rows[0]?.value ?? 0);
  };

  const [reactions, followers, images, posts, profileViews] = await Promise.all([
    netReactionsTotal(),
    count('userEngagements', 'time', `targetUserId = ${uid} AND type = 'Follow'`),
    count('images_created', 'createdAt', `userId = ${uid}`),
    count('posts', 'time', `userId = ${uid} AND type = 'Publish'`),
    count('views', 'time', `entityType = 'User' AND entityId = ${uid}`),
  ]);

  return { reactions, followers, images, posts, profileViews };
}
