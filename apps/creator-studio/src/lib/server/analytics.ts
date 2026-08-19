import { sql } from '@civitai/db/kysely';
import { getClickhouse } from '$lib/server/clickhouse';
import { dbRead } from '$lib/server/db';
import { createCache } from '$lib/server/cache';
import { rangeTtlSeconds } from '$lib/date-range';
import { bucketReactors, type ReactionAudienceSplit } from '$lib/analytics/reaction-audience';
import { viewTrackingSql } from '$lib/analytics/view-tracking';
import { VIEW_ENTITY, IMPRESSION_ENTITY } from '$lib/server/view-entities';
import type { ViewEntity, ImpressionEntity } from '$lib/server/view-entities';

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
  views: number;
  impressions: number;
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
  imageViews: number;
  articleViews: number;
  modelViews: number;
  impressions: number;
};
export type ContentAnalytics = {
  reactions: TimePoint[];
  followers: TimePoint[];
  images: TimePoint[];
  posts: TimePoint[];
  profileViews: TimePoint[];
  imageViews: TimePoint[];
  articleViews: TimePoint[];
  modelViews: TimePoint[];
  /** Feed impressions across the creator's images and models. */
  impressions: TimePoint[];
  totals: ContentTotals;
};

// One image's own series, for the /analytics/content/image/[imageId] drilldown. Views, reactions and comments share
// one x-axis so the page can answer "did the spike in views bring engagement with it".
export type ImageViewDetail = {
  imageId: number;
  url: string;
  nsfwLevel: number;
  type: 'image' | 'video' | 'audio';
  createdAt: string | null;
  series: TimePoint[];
  total: number;
  prevTotal: number;
  lifetime: number;
  reactionSeries: TimePoint[];
  reactionTotal: number;
  commentSeries: TimePoint[];
  commentTotal: number;
  /** Feed impressions on this image. Empty series when the entity type carries none. */
  impressionSeries: TimePoint[];
  impressionTotal: number;
};

// An article row on the /analytics/content Articles tab. `coverUrl` is null for an article with no cover.
export type TopArticle = {
  articleId: number;
  title: string;
  views: number;
  reactions: number;
  impressions: number;
  coverUrl: string | null;
  nsfwLevel: number;
  publishedAt: string | null;
};

// A comic row on the /analytics/content Comics tab. Deliberately `readers`, not `views` — see fetchComics.
export type ComicSummary = {
  projectId: number;
  name: string;
  coverUrl: string | null;
  nsfwLevel: number;
  published: boolean;
  chapters: number;
  readers: number;
  newReaders: number;
  projectViews: number;
  chapterReads: number;
};

// `tracking` distinguishes "nothing to show yet" from "zero", which these surfaces need because their tables
// are live and empty until the emitting code deploys and the backfill runs. Rendering 0 in that window reads
// as a broken feature — and since a mistyped entityType also returns zero silently, an empty chart already
// carries two meanings without adding a third.
export type ComicsPanel = { comics: ComicSummary[]; tracking: boolean };

export type Model3dSummary = {
  model3dId: number;
  name: string;
  coverUrl: string | null;
  nsfwLevel: number;
  published: boolean;
  views: number;
};
export type Model3dPanel = { models: Model3dSummary[]; tracking: boolean };

// The article equivalent of ImageViewDetail, minus the comment series — which is unbuilt, not impossible.
// ClickHouse cannot answer it (the `comments` type enum has no Article arm), but ClickHouse is not where the
// image drilldown reads comments from either: `fetchImageViewDetail` counts `CommentV2` through `Thread`, and
// `Thread.articleId` exists, so the same query shape works here whenever someone wants the series.
export type ArticleViewDetail = {
  articleId: number;
  title: string;
  coverUrl: string | null;
  nsfwLevel: number;
  publishedAt: string | null;
  series: TimePoint[];
  total: number;
  prevTotal: number;
  lifetime: number;
  reactionSeries: TimePoint[];
  reactionTotal: number;
  impressionSeries: TimePoint[];
  impressionTotal: number;
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
  name: 'analytics:content:v4',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchContentAnalytics(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

export const getContentTotals = createCache({
  name: 'analytics:totals:v3',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchContentTotals(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

// Top reacted media over the range (images + videos, split by `type` on each page).
export const getTopMedia = createCache({
  name: 'analytics:top-media:v4',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchTopMedia(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

export const getComics = createCache({
  name: 'analytics:comics:v4',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchComics(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

export const getModel3ds = createCache({
  name: 'analytics:model3d:v3',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchModel3ds(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

export const getArticleViewDetail = createCache({
  name: 'analytics:article-views:v2',
  fetch: ({
    userId,
    articleId,
    from,
    to,
    compareFrom,
    compareTo,
  }: {
    userId: number;
    articleId: number;
    from: string;
    to: string;
    compareFrom: string;
    compareTo: string;
  }) => fetchArticleViewDetail(userId, articleId, from, to, compareFrom, compareTo),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

export const getTopArticles = createCache({
  name: 'analytics:top-articles:v3',
  fetch: ({ userId, from, to }: { userId: number; from: string; to: string }) =>
    fetchTopArticles(userId, from, to),
  ttlSeconds: ({ from, to }) => rangeTtlSeconds({ from, to }),
}).get;

// Keyed on userId as well as imageId: the fetch refuses images the caller doesn't own, so a cache entry is
// only ever valid for the owner it was fetched for.
export const getImageViewDetail = createCache({
  name: 'analytics:image-views:v1',
  fetch: ({
    userId,
    imageId,
    from,
    to,
    compareFrom,
    compareTo,
  }: {
    userId: number;
    imageId: number;
    from: string;
    to: string;
    compareFrom: string;
    compareTo: string;
  }) => fetchImageViewDetail(userId, imageId, from, to, compareFrom, compareTo),
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
//   - `entityMetricTotal_v3` carries two per-image comment metrics — `Comment` (2023-02-15 to 2025-11-06) and
//     `commentCount` (2025-11-06 on, from the event-engine CDC handler). They are two eras of one measurement,
//     not a live one and a dead one. Summing both still fails a ground-truth check across four creators:
//     -11%, +18%, +27%, +30% against Postgres. Consistent with the pipeline's delete path — it resolves an
//     image's owner by reading `Image`, which is already gone on a cascade delete, so the -1 is dropped and the
//     total ratchets up. Three of the four errors are positive.
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

// Image views come from `image_views_daily_by_owner`, a nightly owner-keyed rollup of `daily_views`, because
// the same answer off `daily_views` needs `entityId IN (this creator's images)` — a creator's ids are scattered
// across the whole id space, so the primary key prunes almost nothing and a 400-image creator reads 131M rows.
// Against the rollup it is an `ownerId` prefix seek: 3 marks.
//
// Two consequences of the rollup being a nightly seal, both visible to the reader: today is absent until the
// 02:00 refresh, and views on images with no `images_created` row are dropped by its join (~0.4% in 2026,
// higher the further back you go).
function ownerViewsDailySql(uid: number, from: string, to: string): string {
  return `SELECT createdDate AS date, sum(views) AS value FROM image_views_daily_by_owner WHERE ownerId = ${uid} AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY date ORDER BY date WITH FILL FROM toDate('${from}') TO toDate('${to}') + 1 STEP 1`;
}

// Articles deliberately do NOT get the owner-rollup treatment images needed. There are ~32k articles on the
// platform against 130M images, and the heaviest creator has 438 — so the creator's own ids fit in a literal
// `IN`, which keeps `daily_views`' primary key usable. Measured at the platform's worst case: 35ms / 384 marks.
//
// Ownership comes from Postgres, not ClickHouse. The `articles` table in ClickHouse looks like the equivalent
// of `images_created` and is not: it starts 2026-06-16 and knows the owner of 3,087 of the 32,107 articles that
// have views — 9.6%. Building on it would drop most of every creator's history while still returning a chart.
async function articleIdsFor(uid: number): Promise<number[]> {
  const rows = await dbRead
    .selectFrom('Article')
    .where('userId', '=', uid)
    .select(['id'])
    .execute();
  return rows.map((r) => r.id);
}

// Gap-filled daily article views for an id list. Returns an all-zero series for a creator with no articles
// rather than building an empty `IN ()`, which is a syntax error rather than an empty result.
function articleViewsDailySql(ids: number[], from: string, to: string): string {
  const fill = `ORDER BY date WITH FILL FROM toDate('${from}') TO toDate('${to}') + 1 STEP 1`;
  if (!ids.length) return `SELECT toDate('${from}') AS date, 0 AS value WHERE 0 ${fill}`;
  return `SELECT createdDate AS date, sum(views) AS value FROM daily_views WHERE entityType = '${VIEW_ENTITY.article}' AND entityId IN (${ids.join(
    ','
  )}) AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY date ${fill}`;
}

// The creator's articles ranked by views over the range, enriched from Postgres for title + cover.
async function fetchTopArticles(userId: number, from: string, to: string): Promise<TopArticle[]> {
  const uid = Number(userId);
  const ids = await articleIdsFor(uid);
  if (!ids.length) return [];

  const ch = getClickhouse();
  // Views and reactions are fetched for the same id set so the client can re-rank between them without a
  // second round trip. Reactions are scoped by `ownerId` as well as the id list — `reactions` isn't sorted by
  // entityId, and the owner predicate is what keeps this off a broad scan.
  const [viewRows, reactionRows] = await Promise.all([
    ch.$query<{ articleId: number | string; views: number | string }>(
      `SELECT entityId AS articleId, sum(views) AS views FROM daily_views WHERE entityType = '${VIEW_ENTITY.article}' AND entityId IN (${ids.join(
        ','
      )}) AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY articleId ORDER BY views DESC LIMIT 100`
    ),
    ch.$query<{ articleId: number | string; reactions: number | string }>(
      `SELECT entityId AS articleId, sum(if(type = 'Article_Create', 1, -1)) AS reactions FROM reactions WHERE ownerId = ${uid} AND type IN ('Article_Create', 'Article_Delete') AND entityId IN (${ids.join(
        ','
      )}) AND toDate(time) >= toDate('${from}') AND toDate(time) <= toDate('${to}') GROUP BY articleId`
    ),
  ]);
  const viewsById = new Map(viewRows.map((r) => [Number(r.articleId), Number(r.views)]));
  const reactionsById = new Map(
    reactionRows.map((r) => [Number(r.articleId), Number(r.reactions)])
  );
  // An article with reactions but no views in the period still belongs in the list — otherwise ranking by
  // reactions would silently omit it.
  const shownIds = new Set([...viewsById.keys(), ...reactionsById.keys()]);
  if (!shownIds.size) return [];

  const impressionsById = await fetchImpressionsByEntity(
    VIEW_ENTITY.article,
    [...shownIds],
    from,
    to
  );
  const rows = await dbRead
    .selectFrom('Article')
    .leftJoin('Image', 'Image.id', 'Article.coverId')
    .where('Article.id', 'in', [...shownIds])
    .select([
      'Article.id as id',
      'Article.title as title',
      'Article.nsfwLevel as nsfwLevel',
      'Article.publishedAt as publishedAt',
      'Image.url as coverUrl',
    ])
    .execute();

  return rows
    .map((a) => ({
      articleId: a.id,
      title: a.title ?? `Article ${a.id}`,
      views: viewsById.get(a.id) ?? 0,
      reactions: reactionsById.get(a.id) ?? 0,
      impressions: impressionsById.get(a.id) ?? 0,
      coverUrl: a.coverUrl ?? null,
      nsfwLevel: Number(a.nsfwLevel ?? 0),
      publishedAt: a.publishedAt ? new Date(a.publishedAt).toISOString() : null,
    }))
    .sort((x, y) => y.views - x.views);
}

// Model views are creator-wide here, not per version. A view is of the *model* page, so hanging it off the
// version rows on /analytics/models would repeat the same number once per version and double-count any sum.
//
// Ids come from Postgres for the same reason articles do: models are median 2 per creator (p99 197), so a
// literal `IN` against `daily_views` keeps the primary key usable and includes today. The owner-keyed rollup
// that images need would only pay for itself at the 13,991-model tail.
async function modelIdsFor(uid: number): Promise<number[]> {
  const rows = await dbRead.selectFrom('Model').where('userId', '=', uid).select(['id']).execute();
  return rows.map((r) => r.id);
}

function modelViewsDailySql(ids: number[], from: string, to: string): string {
  const fill = `ORDER BY date WITH FILL FROM toDate('${from}') TO toDate('${to}') + 1 STEP 1`;
  if (!ids.length) return `SELECT toDate('${from}') AS date, 0 AS value WHERE 0 ${fill}`;
  return `SELECT createdDate AS date, sum(views) AS value FROM daily_views WHERE entityType = '${
    VIEW_ENTITY.model
  }' AND entityId IN (${ids.join(
    ','
  )}) AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY date ${fill}`;
}

// Feed impressions on this creator's images. Reads `impressions_daily_by_owner`, whose primary key is
// `(ownerId, entityType, createdDate)` — an owner-keyed rollup exists here for the same reason it does for
// image views: a creator's ids are scattered across a 130M space, so per-entity lookup prunes nothing.
//
// Only the Image and Model arms are populated. Everything else is tracked per-entity but has no ownership
// source in ClickHouse, so it is *absent* rather than zero — do not add arms here speculatively.
// Sums every populated arm, because the tile says "Feed impressions" and not "image impressions". Filtering to
// Image alone showed roughly half the real number under a label claiming all of it — measured over the first 25
// minutes of the 1% ramp, `daily_impressions` held Image 1,456 against Model 1,159.
function impressionsDailySql(uid: number, from: string, to: string): string {
  return `SELECT createdDate AS date, sum(impressions) AS value FROM impressions_daily_by_owner WHERE ownerId = ${uid} AND entityType IN (${impressionArms()}) AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY date ORDER BY date WITH FILL FROM toDate('${from}') TO toDate('${to}') + 1 STEP 1`;
}

const impressionArms = () =>
  Object.values(IMPRESSION_ENTITY)
    .map((e) => `'${e}'`)
    .join(', ');

// Impressions land in their own table rather than `daily_views`, so this cannot reuse `viewTrackingLive`.
// Deliberately uncached, and deliberately NOT part of the cached ContentAnalytics payload — see below.
export async function impressionTrackingLive(): Promise<boolean> {
  const rows = await getClickhouse().$query<{ one: number }>(
    `SELECT 1 AS one FROM impressions_daily_by_owner WHERE entityType IN (${impressionArms()}) LIMIT 1`
  );
  return rows.length > 0;
}

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

  // The article id list has to be resolved from Postgres before its ClickHouse query can be built, so it runs
  // ahead of the fan-out rather than inside it.
  const [articleIds, modelIds] = await Promise.all([articleIdsFor(uid), modelIdsFor(uid)]);

  const [reactions, followers, images, posts, profileViews, imageViews, articleViews, modelViews] =
    await Promise.all([
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
      series(ownerViewsDailySql(uid, from, to)),
      series(articleViewsDailySql(articleIds, from, to)),
      series(modelViewsDailySql(modelIds, from, to)),
    ]);

  const impressions = await series(impressionsDailySql(uid, from, to));

  const sum = (s: TimePoint[]) => s.reduce((acc, p) => acc + p.value, 0);
  return {
    reactions,
    followers,
    images,
    posts,
    profileViews,
    imageViews,
    articleViews,
    modelViews,
    impressions,
    totals: {
      reactions: sum(reactions),
      followers: sum(followers),
      images: sum(images),
      posts: sum(posts),
      profileViews: sum(profileViews),
      imageViews: sum(imageViews),
      articleViews: sum(articleViews),
      modelViews: sum(modelViews),
      impressions: sum(impressions),
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
  return enrichTopImages(raw, from, to);
}

// Per-image view counts for an already-ranked, bounded id list. Reads `daily_views` rather than the owner rollup,
// which is aggregated past the point of naming an image; a literal id set keeps the primary key usable.
async function fetchViewsByImage(
  ids: number[],
  from: string,
  to: string
): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await getClickhouse().$query<{ imageId: number | string; views: number | string }>(
    `SELECT entityId AS imageId, sum(views) AS views FROM daily_views WHERE entityType = '${VIEW_ENTITY.image}' AND entityId IN (${ids.join(
      ','
    )}) AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY imageId`
  );
  return new Map(rows.map((r) => [Number(r.imageId), Number(r.views)]));
}

// Per-entity feed impressions for a bounded id list. `daily_impressions` is keyed
// `(entityType, entityId, createdDate)`, so this is the same prefix-seek shape as the views lookup — the
// owner rollup answers "how many across everything I own", this answers "how many for this one thing".
//
// Only Image, Model and Article carry meaningful volume today (29.0M / 26.0M / 134.7k). Comics and 3D models
// are not feed entities, so they have none — absent rather than zero.
/** Gap-filled daily impressions for ONE entity, for the drilldown charts. */
function entityImpressionsSql(entityType: string, id: number, from: string, to: string): string {
  return `SELECT createdDate AS date, sum(impressions) AS value FROM daily_impressions WHERE entityType = '${entityType}' AND entityId = ${id} AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY date ORDER BY date WITH FILL FROM toDate('${from}') TO toDate('${to}') + 1 STEP 1`;
}

async function fetchImpressionsByEntity(
  entityType: ViewEntity | ImpressionEntity,
  ids: number[],
  from: string,
  to: string
): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await getClickhouse().$query<{ id: number | string; impressions: number | string }>(
    `SELECT entityId AS id, sum(impressions) AS impressions FROM daily_impressions WHERE entityType = '${entityType}' AND entityId IN (${ids.join(
      ','
    )}) AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY id`
  );
  return new Map(rows.map((r) => [Number(r.id), Number(r.impressions)]));
}

// Look up the CF url + nsfwLevel for the top images (Postgres, by primary key) so the analytics grid can show real
// thumbnails instead of bare IDs. Order is preserved from the ClickHouse ranking.
async function enrichTopImages(
  raw: { imageId: number | string; reactions: number | string }[],
  from: string,
  to: string
): Promise<TopImage[]> {
  const ids = raw.map((r) => Number(r.imageId));
  const [rows, viewsById, impressionsById] = await Promise.all([
    ids.length
      ? dbRead
          .selectFrom('Image')
          .where('id', 'in', ids)
          .select(['id', 'url', 'nsfwLevel', 'type'])
          .execute()
      : Promise.resolve([]),
    fetchViewsByImage(ids, from, to),
    fetchImpressionsByEntity(VIEW_ENTITY.image, ids, from, to),
  ]);
  const byId = new Map(rows.map((i) => [i.id, i]));
  // Drop deleted images (no Image row / no url) — we don't surface them in the grid.
  return raw
    .map((r): TopImage | null => {
      const img = byId.get(Number(r.imageId));
      if (!img?.url) return null;
      return {
        imageId: Number(r.imageId),
        reactions: Number(r.reactions),
        views: viewsById.get(Number(r.imageId)) ?? 0,
        impressions: impressionsById.get(Number(r.imageId)) ?? 0,
        url: img.url,
        nsfwLevel: Number(img.nsfwLevel ?? 0),
        type: img.type as 'image' | 'video' | 'audio',
      };
    })
    .filter((x): x is TopImage => x !== null);
}

// One image's view series for the drilldown. Ownership is checked against Postgres first and a miss returns
// null rather than an empty chart: `Image` is the only place ownership lives, and without the check any
// signed-in creator could read any image's numbers by editing the URL.
//
// Reads `daily_views` (not the owner rollup, which no longer knows about individual images). `entityId` is the
// second column of that table's primary key, so a single image is a 10-mark seek and today's views are already
// there — this page is not subject to the rollup's nightly lag.
async function fetchImageViewDetail(
  userId: number,
  imageId: number,
  from: string,
  to: string,
  compareFrom: string,
  compareTo: string
): Promise<ImageViewDetail | null> {
  const uid = Number(userId);
  const id = Number(imageId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const image = await dbRead
    .selectFrom('Image')
    .where('id', '=', id)
    .where('userId', '=', uid)
    .select(['id', 'url', 'nsfwLevel', 'type', 'createdAt'])
    .executeTakeFirst();
  if (!image?.url) return null;

  const ch = getClickhouse();
  const fill = `ORDER BY date WITH FILL FROM toDate('${from}') TO toDate('${to}') + 1 STEP 1`;

  // Reactions are scoped to the selected month on purpose: `reactions` is sorted `(time, reaction, entityId,
  // userId)`, so the date predicate is what makes this cheap — it prunes to one monthly partition and skips
  // granules on the `time` prefix. Unbounded, the same query scans every partition: 2.4s against 155ms for a
  // month. That's why there's no all-time reaction figure on this page.
  //
  // Comments do NOT come from ClickHouse. `comments.entityId` is the **CommentV2 id**, not the entity id, for
  // every type except Model — 970k image-comment rows over 970,422 distinct entityIds, max 2,309,059 against
  // image ids past 139M. Joining it on an image id doesn't error, it silently returns whatever ancient image
  // shares that number. Postgres via `Thread` is the only correct source; `rootThreadId` picks up replies,
  // which count as comments on the image.
  const [seriesRows, prevRows, lifetimeRows, reactionRows, commentRows, impressionRows] =
    await Promise.all([
      ch.$query<{ date: string; value: number | string }>(
        `SELECT createdDate AS date, sum(views) AS value FROM daily_views WHERE entityType = '${VIEW_ENTITY.image}' AND entityId = ${id} AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY date ${fill}`
      ),
      ch.$query<{ value: number | string }>(
        `SELECT sum(views) AS value FROM daily_views WHERE entityType = '${VIEW_ENTITY.image}' AND entityId = ${id} AND createdDate >= toDate('${compareFrom}') AND createdDate <= toDate('${compareTo}')`
      ),
      ch.$query<{ value: number | string }>(
        `SELECT sum(views) AS value FROM daily_views WHERE entityType = '${VIEW_ENTITY.image}' AND entityId = ${id}`
      ),
      // Same net-of-deletes accounting as every other reaction figure in the Studio — un-reacting writes an
      // `Image_Delete` row rather than removing the create, so a plain count would drift upward forever.
      ch.$query<{ date: string; value: number | string }>(
        `SELECT toDate(time) AS date, ${netReactions} AS value FROM reactions WHERE entityId = ${id} AND type IN ('Image_Create', 'Image_Delete') AND toDate(time) >= toDate('${from}') AND toDate(time) <= toDate('${to}') GROUP BY date ${fill}`
      ),
      sql<{ date: string; value: number | string }>`
      SELECT c."createdAt"::date AS date, count(*)::int AS value
      FROM "CommentV2" c
      JOIN "Thread" t ON t.id = c."threadId"
      WHERE (t."imageId" = ${id} OR t."rootThreadId" IN (SELECT id FROM "Thread" WHERE "imageId" = ${id}))
        AND c."createdAt" >= ${from}::date AND c."createdAt" < (${to}::date + 1)
      GROUP BY date ORDER BY date
    `
        .execute(dbRead)
        .then((r) => r.rows),
      ch.$query<{ date: string; value: number | string }>(
        entityImpressionsSql(VIEW_ENTITY.image, id, from, to)
      ),
    ]);

  const points = (rows: { date: string; value: number | string }[]) =>
    rows.map((r) => ({ date: String(r.date), value: Number(r.value) }));
  const sum = (s: TimePoint[]) => s.reduce((acc, p) => acc + p.value, 0);

  const series = points(seriesRows);
  const reactionSeries = points(reactionRows);
  // Postgres has no `WITH FILL`, so the comment series is gap-filled here against the view series' dates —
  // the three charts share a crosshair and would otherwise disagree about the x-axis.
  const commentsByDate = new Map(
    points(commentRows).map((p) => [p.date.slice(0, 10), p.value] as const)
  );
  const commentSeries = series.map((p) => ({
    date: p.date,
    value: commentsByDate.get(p.date.slice(0, 10)) ?? 0,
  }));
  const impressionSeries = points(impressionRows);
  return {
    imageId: id,
    url: image.url,
    nsfwLevel: Number(image.nsfwLevel ?? 0),
    type: image.type as 'image' | 'video' | 'audio',
    createdAt: image.createdAt ? new Date(image.createdAt).toISOString() : null,
    series,
    total: sum(series),
    prevTotal: Number(prevRows[0]?.value ?? 0),
    lifetime: Number(lifetimeRows[0]?.value ?? 0),
    reactionSeries,
    reactionTotal: sum(reactionSeries),
    commentSeries,
    commentTotal: sum(commentSeries),
    impressionSeries,
    impressionTotal: sum(impressionSeries),
  };
}

// Answers "not collecting yet" as distinct from "you have none", for the range the surrounding numbers cover.
// The query — and why it must carry the range — is in `$lib/analytics/view-tracking`.
//
// 🔴 Deliberately NOT cached, and the reason is the asymmetry. For any given range this answer starts false
// and flips true once, forever. Caching it means caching a `false` — and a cached `false` outlives the event
// it is wrong about, so the surface keeps saying "not collecting yet" for the whole TTL after data lands.
// That is exactly what happened with a 1h TTL: impressions were live and attributed, and the tile stayed
// hidden. A stale `true` would be harmless; a stale `false` hides a working feature and looks identical to
// the real pre-launch state.
export async function viewTrackingLive(
  entityType: string,
  from: string,
  to: string
): Promise<boolean> {
  const rows = await getClickhouse().$query<{ one: number }>(viewTrackingSql(entityType, from, to));
  return rows.length > 0;
}

// A creator's 3D models, ranked by views over the range. 539 rows platform-wide, so ownership resolves from
// Postgres and the id list goes straight into a literal `IN` — no rollup, and today is included.
//
// A "view" here is one load of the public detail page: `/3d-models/<id>/edit` and `/reviews` are excluded at
// the emitter, on both sides of the cutover, so this number never counts a creator visiting their own draft.
async function fetchModel3ds(userId: number, from: string, to: string): Promise<Model3dPanel> {
  const uid = Number(userId);
  const rows = await dbRead
    .selectFrom('Model3D')
    .leftJoin('Image', 'Image.id', 'Model3D.thumbnailImageId')
    .where('Model3D.userId', '=', uid)
    .where('Model3D.deletedAt', 'is', null)
    .select([
      'Model3D.id as id',
      'Model3D.name as name',
      'Model3D.nsfwLevel as nsfwLevel',
      'Model3D.publishedAt as publishedAt',
      'Image.url as coverUrl',
    ])
    .execute();

  const tracking = await viewTrackingLive(VIEW_ENTITY.model3d, from, to);
  if (!rows.length) return { models: [], tracking };

  const viewRows = await getClickhouse().$query<{ id: number | string; views: number | string }>(
    `SELECT entityId AS id, sum(views) AS views FROM daily_views WHERE entityType = '${
      VIEW_ENTITY.model3d
    }' AND entityId IN (${rows
      .map((r) => r.id)
      .join(
        ','
      )}) AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY id`
  );
  const viewsById = new Map(viewRows.map((r) => [Number(r.id), Number(r.views)]));

  return {
    tracking,
    models: rows
      .map((m) => ({
        model3dId: m.id,
        name: m.name ?? `3D model ${m.id}`,
        coverUrl: m.coverUrl ?? null,
        nsfwLevel: Number(m.nsfwLevel ?? 0),
        published: !!m.publishedAt,
        views: viewsById.get(m.id) ?? 0,
      }))
      .sort((a, b) => b.views - a.views || b.model3dId - a.model3dId),
  };
}

// Comics report READERS, not views, and the distinction is the whole point of this function.
//
// Comics have no entity view tracking at all: `views`' entityType enum has no Comic arm and no comic page fires
// a `TrackView`. Comic page hits *are* in `pageViews` (`pageId` is the full path, e.g. `/comics/3203/slug`), but
// `pageViews` is ordered `(time, pageId, userId)`, so filtering on a path scans the whole month — measured at
// **128.5M rows / 396ms for a single comic**. That is fine for a nightly rollup and unacceptable on a page load,
// so the view number waits for the rollup being built separately rather than being faked from a scan here.
//
// What Postgres can answer cheaply is readers, from `ComicChapterRead` — but note its shape before trusting it:
// it is keyed `(userId, chapterId)`, so it is a unique-reader marker rather than a read log (a re-read updates a
// row instead of adding one), and `userId` is a required FK, so **logged-out readers are not counted at all**.
// `newReaders` therefore means "people who read a chapter of this comic for the first time in this period".
//
// Project views and chapter reads are separate entity types and no row is counted in both: the overview page
// emits `ComicProject`, the reader emits `ComicChapter`, and the reader re-emits when you navigate between
// chapters without remounting — correctly, that is a second read. Chapter reads are gated on `canRead`, so a
// paywalled early-access chapter a viewer could not open does not count, which keeps the number comparable
// with `ComicChapterRead`.
async function fetchComics(userId: number, from: string, to: string): Promise<ComicsPanel> {
  const uid = Number(userId);
  const result = await sql<{
    projectId: number;
    name: string;
    coverUrl: string | null;
    nsfwLevel: number;
    published: boolean;
    chapters: string | number;
    readers: string | number;
    newReaders: string | number;
  }>`
    SELECT p.id                                        AS "projectId",
           p.name                                      AS "name",
           i.url                                       AS "coverUrl",
           p."nsfwLevel"                               AS "nsfwLevel",
           (p."publishedAt" IS NOT NULL)               AS "published",
           count(DISTINCT c.id)                        AS "chapters",
           count(DISTINCT r."userId")                  AS "readers",
           count(DISTINCT r."userId") FILTER (
             WHERE r."createdAt" >= ${from}::date AND r."createdAt" < (${to}::date + 1)
           )                                           AS "newReaders"
    FROM "ComicProject" p
    LEFT JOIN "ComicChapter" c ON c."projectId" = p.id
    LEFT JOIN "ComicChapterRead" r ON r."chapterId" = c.id
    LEFT JOIN "Image" i ON i.id = p."coverImageId"
    WHERE p."userId" = ${uid}
    GROUP BY p.id, p.name, i.url, p."nsfwLevel", p."publishedAt"
    ORDER BY count(DISTINCT r."userId") DESC, p.id DESC
  `.execute(dbRead);

  const tracking = await viewTrackingLive(VIEW_ENTITY.comicProject, from, to);
  const projectIds = result.rows.map((r) => Number(r.projectId));
  if (!projectIds.length) return { comics: [], tracking };

  // Chapter reads key on `ComicChapter.id`, so the chapter ids have to be resolved here and mapped back to
  // their project. Both lists are tiny — 2,922 projects and 4,318 chapters platform-wide.
  const chapterRows = await sql<{ id: number; projectId: number }>`
    SELECT id, "projectId" FROM "ComicChapter" WHERE "projectId" = ANY(${projectIds})
  `.execute(dbRead);
  const projectByChapter = new Map(
    chapterRows.rows.map((c) => [Number(c.id), Number(c.projectId)] as const)
  );

  const ch = getClickhouse();
  const range = `createdDate >= toDate('${from}') AND createdDate <= toDate('${to}')`;
  const [projectViewRows, chapterViewRows] = await Promise.all([
    ch.$query<{ id: number | string; views: number | string }>(
      `SELECT entityId AS id, sum(views) AS views FROM daily_views WHERE entityType = '${
        VIEW_ENTITY.comicProject
      }' AND entityId IN (${projectIds.join(',')}) AND ${range} GROUP BY id`
    ),
    projectByChapter.size
      ? ch.$query<{ id: number | string; views: number | string }>(
          `SELECT entityId AS id, sum(views) AS views FROM daily_views WHERE entityType = '${
            VIEW_ENTITY.comicChapter
          }' AND entityId IN (${[...projectByChapter.keys()].join(',')}) AND ${range} GROUP BY id`
        )
      : Promise.resolve([]),
  ]);

  const projectViews = new Map(projectViewRows.map((r) => [Number(r.id), Number(r.views)]));
  const chapterReads = new Map<number, number>();
  for (const r of chapterViewRows) {
    const projectId = projectByChapter.get(Number(r.id));
    if (projectId === undefined) continue;
    chapterReads.set(projectId, (chapterReads.get(projectId) ?? 0) + Number(r.views));
  }

  return {
    tracking,
    comics: result.rows.map((r) => {
      const projectId = Number(r.projectId);
      return {
        projectId,
        name: r.name ?? `Comic ${projectId}`,
        coverUrl: r.coverUrl ?? null,
        nsfwLevel: Number(r.nsfwLevel ?? 0),
        published: !!r.published,
        chapters: Number(r.chapters),
        readers: Number(r.readers),
        newReaders: Number(r.newReaders),
        projectViews: projectViews.get(projectId) ?? 0,
        chapterReads: chapterReads.get(projectId) ?? 0,
      };
    }),
  };
}

// One article's series for the /analytics/content/article/[articleId] drilldown — the article-shaped twin of
// fetchImageViewDetail, down to enforcing ownership in the Postgres lookup and returning null on a miss.
// Unlike the image page there is no nightly-rollup caveat here: articles read `daily_views` directly, so this
// includes today.
async function fetchArticleViewDetail(
  userId: number,
  articleId: number,
  from: string,
  to: string,
  compareFrom: string,
  compareTo: string
): Promise<ArticleViewDetail | null> {
  const uid = Number(userId);
  const id = Number(articleId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const article = await dbRead
    .selectFrom('Article')
    .leftJoin('Image', 'Image.id', 'Article.coverId')
    .where('Article.id', '=', id)
    .where('Article.userId', '=', uid)
    .select([
      'Article.id as id',
      'Article.title as title',
      'Article.nsfwLevel as nsfwLevel',
      'Article.publishedAt as publishedAt',
      'Image.url as coverUrl',
    ])
    .executeTakeFirst();
  if (!article) return null;

  const ch = getClickhouse();
  const fill = `ORDER BY date WITH FILL FROM toDate('${from}') TO toDate('${to}') + 1 STEP 1`;
  const [seriesRows, prevRows, lifetimeRows, reactionRows, impressionRows] = await Promise.all([
    ch.$query<{ date: string; value: number | string }>(
      `SELECT createdDate AS date, sum(views) AS value FROM daily_views WHERE entityType = '${VIEW_ENTITY.article}' AND entityId = ${id} AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}') GROUP BY date ${fill}`
    ),
    ch.$query<{ value: number | string }>(
      `SELECT sum(views) AS value FROM daily_views WHERE entityType = '${VIEW_ENTITY.article}' AND entityId = ${id} AND createdDate >= toDate('${compareFrom}') AND createdDate <= toDate('${compareTo}')`
    ),
    ch.$query<{ value: number | string }>(
      `SELECT sum(views) AS value FROM daily_views WHERE entityType = '${VIEW_ENTITY.article}' AND entityId = ${id}`
    ),
    // Month-scoped for the same reason as the image page: `reactions` isn't sorted by entityId, so the date
    // predicate is what keeps this off a full-table scan.
    ch.$query<{ date: string; value: number | string }>(
      `SELECT toDate(time) AS date, sum(if(type = 'Article_Create', 1, -1)) AS value FROM reactions WHERE entityId = ${id} AND type IN ('Article_Create', 'Article_Delete') AND toDate(time) >= toDate('${from}') AND toDate(time) <= toDate('${to}') GROUP BY date ${fill}`
    ),
    ch.$query<{ date: string; value: number | string }>(
      entityImpressionsSql(VIEW_ENTITY.article, id, from, to)
    ),
  ]);

  const points = (rows: { date: string; value: number | string }[]) =>
    rows.map((r) => ({ date: String(r.date), value: Number(r.value) }));
  const sum = (s: TimePoint[]) => s.reduce((acc, p) => acc + p.value, 0);

  const series = points(seriesRows);
  const reactionSeries = points(reactionRows);
  return {
    articleId: id,
    title: article.title ?? `Article ${id}`,
    coverUrl: article.coverUrl ?? null,
    nsfwLevel: Number(article.nsfwLevel ?? 0),
    publishedAt: article.publishedAt ? new Date(article.publishedAt).toISOString() : null,
    series,
    total: sum(series),
    prevTotal: Number(prevRows[0]?.value ?? 0),
    lifetime: Number(lifetimeRows[0]?.value ?? 0),
    reactionSeries,
    reactionTotal: sum(reactionSeries),
    impressionSeries: points(impressionRows),
    impressionTotal: sum(points(impressionRows)),
  };
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

  const imageViewsTotal = async (): Promise<number> => {
    const rows = await ch.$query<{ value: number | string }>(
      `SELECT sum(views) AS value FROM image_views_daily_by_owner WHERE ownerId = ${uid} AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}')`
    );
    return Number(rows[0]?.value ?? 0);
  };

  const articleIds = await articleIdsFor(uid);
  const articleViewsTotal = async (): Promise<number> => {
    if (!articleIds.length) return 0;
    const rows = await ch.$query<{ value: number | string }>(
      `SELECT sum(views) AS value FROM daily_views WHERE entityType = '${VIEW_ENTITY.article}' AND entityId IN (${articleIds.join(
        ','
      )}) AND createdDate >= toDate('${from}') AND createdDate <= toDate('${to}')`
    );
    return Number(rows[0]?.value ?? 0);
  };

  const [reactions, followers, images, posts, profileViews, imageViews, articleViews] =
    await Promise.all([
      netReactionsTotal(),
      count('userEngagements', 'time', `targetUserId = ${uid} AND type = 'Follow'`),
      count('images_created', 'createdAt', `userId = ${uid}`),
      count('posts', 'time', `userId = ${uid} AND type = 'Publish'`),
      count('views', 'time', `entityType = 'User' AND entityId = ${uid}`),
      imageViewsTotal(),
      articleViewsTotal(),
    ]);

  // The dashboard's activity row doesn't surface impressions, so this pays for no extra query — but the field
  // is part of ContentTotals, so it has to be present rather than absent.
  return {
    reactions,
    followers,
    images,
    posts,
    profileViews,
    imageViews,
    articleViews,
    modelViews: 0,
    impressions: 0,
  };
}
