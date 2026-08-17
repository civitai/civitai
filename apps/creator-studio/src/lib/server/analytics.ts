import { sql } from '@civitai/db/kysely';
import { getClickhouse } from '$lib/server/clickhouse';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { rangeTtlSeconds } from '$lib/date-range';
import { bucketReactors, type ReactionAudienceSplit } from '$lib/analytics/reaction-audience';

export type { AudienceBucket, ReactionAudienceSplit } from '$lib/analytics/reaction-audience';

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

// The two halves of this type have different scopes and every label that renders them has to say so. `reactions` is
// **all content** — `reactions_owner_scores` aggregates `reactions.ownerId` across images, models, articles and the
// rest, which is what `UserMetric.reactionCount` uses, so this agrees with the creator's profile. `comments` is
// **images only, from other people**, counted in Postgres.
export type AllTimeTotals = { reactions: number; comments: number };

// Cached read-through wrappers. The named args double as the cache key; the TTL scales with the range span
// (span-based, capped at 30 min) so reloads/back-nav hit Redis, not ClickHouse (fail-open). The `name` carries a
// version suffix because the args alone don't distinguish a change in what the numbers *mean* — bump it whenever one
// of these queries changes, or warm keys keep serving the old shape past the deploy. These four expire independently,
// so a stale one next to a fresh one puts contradictory reaction totals on /dashboard and /analytics at once.
export const getContentAnalytics = createCache({
  name: 'analytics:content:v2',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchContentAnalytics(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

export const getContentTotals = createCache({
  name: 'analytics:totals:v2',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchContentTotals(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

// Top reacted media over the range (images + videos, split by `type` on each page).
export const getTopMedia = createCache({
  name: 'analytics:top-media:v2',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchTopMedia(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

export const getReactionAudienceSplit = createCache({
  name: 'analytics:reaction-split:v1',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchReactionAudienceSplit(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

// Comments come from Postgres, not ClickHouse, because no ClickHouse table can answer this correctly:
//
//   - `image_metrics_user` (what this read until now) is a dead one-off backfill. Nothing writes it, and its max
//     userId is 9.66M against current ids past 12.5M — frozen for everyone it covers, **0** for everyone newer.
//   - `comments` looks like the replacement and is a trap. Its `entityId` is the **CommentV2 id**, not the entity
//     commented on, for every `type` except `Model`. The tell: 970,679 rows of `type = 'Image'` over 970,422
//     distinct entityIds, and Image/Post/Comment/Review/Bounty all share one id range (45,825–2,309,025) that
//     overlaps between them, while real image ids are past 139M. Joining it to `images_created.id` does not error —
//     ids that low exist — it silently credits each comment to whatever ancient image shares its number.
//   - `entityMetricTotal_v3` carries two per-image comment metrics and neither survives a ground-truth check:
//     across four creators `commentCount` ran -6% to +79% against Postgres and `Comment` was short by up to 97%.
//
// Do not generalise that middle point to `reactions`, which sits beside `comments` and looks like it. Its
// `entityId` **is** the entity reacted to, and each `type` keeps to its own id space rather than sharing one:
// over 30 days `Image_Create` runs to 139,931,065 across 19,428,878 rows / 6,203,813 distinct ids (3.13 per
// image) while `CommentV2_Create` tops out at 2,309,122 against `max("CommentV2".id) = 2,309,121`. Sampled 6
// `Image_Create` rows against Postgres: every `entityId` is a live `Image` whose `userId` is the CH `ownerId`.
// Only `fetchTopMedia` keys off `reactions.entityId`; the rest of this file uses `reactions.ownerId`, which is
// what `reactions_owner_scores` aggregates. `comments` is the odd one out, and the reason is worth knowing —
// `reactions` rows are emitted by the reaction handler, which knows the entity, while `comments` rows are
// emitted by the comment handler, which knows the comment. There `type` says what was commented **on** and
// `entityId` says which comment. Nothing in the schema shows that.
//
// Three things about the query that are load-bearing, all of them measured rather than reasoned:
//
//   - **It counts `CommentV2` rows, not `Thread.commentCount`.** The counter is exact (its trigger fires on every
//     insert and delete) but it is a per-thread total with no author in it, and `AND cv."userId" <> uid` is the
//     whole point: `update_thread_comment_count` increments unconditionally, so a creator who answers their own
//     commenters inflates their own "comments received". Measured: 71.4% / 60.9% / 57.6% of the raw total was
//     self-authored for userIds 1421581 / 2895 / 1279061. This tile renders on an **audience** page.
//   - **The two arms must stay separate.** Collapsing them into
//     `WHERE t.id IN (roots) OR t."rootThreadId" IN (roots)` makes both indexes unusable and seq-scans all 5.4M
//     `Thread` rows on **every** cache miss — 683ms / ~350MB of buffers even for a creator with two images and
//     zero comments. Split + `MATERIALIZED`, it is an index path: 46ms at that floor, 1.6s at the platform's
//     largest creator (994880, 802,838 images). This runs on the SSR blocking path.
//   - **`roots` joins `Image`, so a deleted image takes its comments with it.** `Thread.imageId` is
//     `onDelete: SetNull`, orphaning ~234k root threads holding ~179k comments platform-wide. The number is
//     therefore "all-time on images that still exist" and can fall month over month.
export const getAllTimeTotals = createCache({
  name: 'analytics:alltime:v3',
  fetch: async ({ userId }: { userId: number }): Promise<AllTimeTotals> => {
    const uid = Number(userId);
    const [reactionRows, commentResult] = await Promise.all([
      getClickhouse().$query<{ reactions: number | string }>(
        `SELECT sum(score) AS reactions FROM reactions_owner_scores WHERE ownerId = ${uid}`
      ),
      sql<{ comments: number | string }>`
        WITH roots AS MATERIALIZED (
          SELECT t.id FROM "Thread" t JOIN "Image" i ON i.id = t."imageId" WHERE i."userId" = ${uid}
        ), threads AS MATERIALIZED (
          SELECT id FROM roots
          UNION ALL
          SELECT c.id FROM "Thread" c JOIN roots r ON c."rootThreadId" = r.id
        )
        SELECT count(*) AS comments
        FROM "CommentV2" cv JOIN threads th ON th.id = cv."threadId"
        WHERE cv."userId" <> ${uid}
      `.execute(dbRead),
    ]);
    return {
      reactions: Number(reactionRows[0]?.reactions ?? 0),
      comments: Number(commentResult.rows[0]?.comments ?? 0),
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

// Bounded by the number of *reactors*, never the number of followers: `UserEngagement`'s only usable index is its
// PK `(userId, targetUserId)`, so "does this user follow X" is an index seek while "everyone who follows X" is a
// seq scan. We therefore aggregate reactors in ClickHouse first and probe Postgres with that list — measured 143
// index searches / ~96 ms for a creator's all-time reactor set (~87k), against 825M reaction rows.
//
// `reactions` carries the reactor on every row back to 2023-04-27 with no TTL, so this is not limited to a rolling
// window the way an `entityMetricEvents_month` approach would be — any range the picker offers works, including a
// future lifetime range, with no new materialized view.
async function fetchReactionAudienceSplit(
  userId: number,
  from: string,
  to: string
): Promise<ReactionAudienceSplit> {
  const uid = Number(userId);
  const rows = await getClickhouse().$query<{
    reactorId: number | string;
    reactions: number | string;
  }>(
    `SELECT userId AS reactorId, ${netReactions} AS reactions FROM reactions WHERE ownerId = ${uid} AND toDate(time) >= toDate('${from}') AND toDate(time) <= toDate('${to}') GROUP BY reactorId`
  );

  // Rows with no actor (611 all-time, across 399 owners) fall through to non-followers rather than being filtered:
  // a reactor with no session isn't following, and dropping them would make the buckets stop summing to the
  // reactions total this page already shows.
  const reactors = rows.map((r) => ({ id: Number(r.reactorId), reactions: Number(r.reactions) }));
  const otherIds = reactors.filter((r) => r.id !== uid && r.id > 0).map((r) => r.id);

  // `= ANY($1)` and not an `in` list: kysely expands `in` to one placeholder per id, and a heavy creator's reactor
  // set is past Postgres' 65535-parameter ceiling.
  const followerIds = new Set<number>();
  if (otherIds.length) {
    const result = await sql<{ userId: number }>`
      SELECT "userId" FROM "UserEngagement"
      WHERE "targetUserId" = ${uid} AND "type" = 'Follow' AND "userId" = ANY(${otherIds})
    `.execute(dbRead);
    for (const row of result.rows) followerIds.add(Number(row.userId));
  }

  return bucketReactors(reactors, uid, followerIds);
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
