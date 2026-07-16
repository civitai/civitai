import { sql } from 'kysely';
import type { Kysely, Selectable } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

// Column enums derived from the schema (Selectable unwraps the Generated<> wrappers) so this module needs no
// moderator-app type import. ArticleRatingReview.status is the shared ReportStatus enum; the review UI only
// filters over its Pending/Actioned/Unactioned members.
type RatingReviewStatus = Selectable<DB['ArticleRatingReview']>['status'];
type ImageMediaType = Selectable<DB['Image']>['type'];

export type RatingReviewUser = {
  id: number;
  username: string | null;
  image: string | null;
};

export type RatingReviewRow = {
  id: number;
  createdAt: Date | null;
  resolvedAt: Date | null;
  status: RatingReviewStatus;
  currentLevel: number;
  suggestedLevel: number;
  appliedLevel: number | null;
  userComment: string | null;
  modComment: string | null;
  user: RatingReviewUser;
  // Null for auto-approved / system-resolved rows.
  resolver: RatingReviewUser | null;
  article: {
    id: number;
    title: string;
    nsfwLevel: number;
    userNsfwLevel: number;
    moderatorNsfwLevel: number | null;
    coverUrl: string | null;
    coverType: ImageMediaType | null;
  };
};

type RawRow = {
  id: number;
  createdAt: Date | null;
  resolvedAt: Date | null;
  status: RatingReviewStatus;
  currentLevel: number;
  suggestedLevel: number;
  appliedLevel: number | null;
  userComment: string | null;
  modComment: string | null;
  ownerId: number;
  ownerUsername: string | null;
  ownerImage: string | null;
  resolverId: number | null;
  resolverUsername: string | null;
  resolverImage: string | null;
  articleId: number;
  articleTitle: string;
  articleNsfwLevel: number;
  articleUserNsfwLevel: number;
  articleModeratorNsfwLevel: number | null;
  // Legacy URL column — null for current articles; the live cover is resolved from coverId below.
  articleCover: string | null;
  articleCoverId: number | null;
};

export type ArticleCoverImage = {
  id: number;
  url: string;
  type: ImageMediaType;
};

// The live cover image for a set of articles (`Article.coverId` → `Image`). Split out from
// getArticleRatingReviews so it is independently EXPLAIN-testable; guarded against an empty id list.
export async function getArticleCoverImages(
  db: Kysely<DB>,
  coverIds: number[]
): Promise<ArticleCoverImage[]> {
  if (!coverIds.length) return [];
  return db.selectFrom('Image').select(['id', 'url', 'type']).where('id', 'in', coverIds).execute();
}

// A page of article rating-review requests of one status, newest first, joined to the owner + (optional)
// resolver and the article. Covers are resolved in a second query (the legacy `Article.cover` string is null
// for current articles, so the live cover comes from `coverId`). Ported from the moderator app.
export async function getArticleRatingReviews(
  db: Kysely<DB>,
  {
    status,
    page = 1,
    limit = 20,
  }: {
    status: RatingReviewStatus;
    page?: number;
    limit?: number;
  }
): Promise<{ items: RatingReviewRow[]; page: number; limit: number }> {
  const offset = (page - 1) * limit;

  const rows = (await db
    .selectFrom('ArticleRatingReview')
    .innerJoin('User as owner', 'owner.id', 'ArticleRatingReview.userId')
    .leftJoin('User as resolver', 'resolver.id', 'ArticleRatingReview.resolvedBy')
    .innerJoin('Article', 'Article.id', 'ArticleRatingReview.articleId')
    .where('ArticleRatingReview.status', '=', status)
    .select([
      'ArticleRatingReview.id',
      'ArticleRatingReview.createdAt',
      'ArticleRatingReview.resolvedAt',
      'ArticleRatingReview.status',
      'ArticleRatingReview.currentLevel',
      'ArticleRatingReview.suggestedLevel',
      'ArticleRatingReview.appliedLevel',
      'ArticleRatingReview.userComment',
      'ArticleRatingReview.modComment',
      'owner.id as ownerId',
      'owner.username as ownerUsername',
      'owner.image as ownerImage',
      'resolver.id as resolverId',
      'resolver.username as resolverUsername',
      'resolver.image as resolverImage',
      'Article.id as articleId',
      'Article.title as articleTitle',
      'Article.nsfwLevel as articleNsfwLevel',
      'Article.userNsfwLevel as articleUserNsfwLevel',
      'Article.moderatorNsfwLevel as articleModeratorNsfwLevel',
      'Article.cover as articleCover',
      'Article.coverId as articleCoverId',
    ])
    .orderBy('ArticleRatingReview.id', 'desc')
    .limit(limit)
    .offset(offset)
    .execute()) as RawRow[];

  const coverIds = [
    ...new Set(rows.map((r) => r.articleCoverId).filter((v): v is number => v != null)),
  ];
  const covers = await getArticleCoverImages(db, coverIds);
  const coverById = new Map(covers.map((c) => [c.id, c]));

  const items: RatingReviewRow[] = rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    resolvedAt: r.resolvedAt,
    status: r.status,
    currentLevel: r.currentLevel,
    suggestedLevel: r.suggestedLevel,
    appliedLevel: r.appliedLevel,
    userComment: r.userComment,
    modComment: r.modComment,
    user: { id: r.ownerId, username: r.ownerUsername, image: r.ownerImage },
    resolver:
      r.resolverId != null
        ? { id: r.resolverId, username: r.resolverUsername, image: r.resolverImage }
        : null,
    article: {
      id: r.articleId,
      title: r.articleTitle,
      nsfwLevel: r.articleNsfwLevel,
      userNsfwLevel: r.articleUserNsfwLevel,
      moderatorNsfwLevel: r.articleModeratorNsfwLevel,
      coverUrl:
        (r.articleCoverId != null ? coverById.get(r.articleCoverId)?.url : null) ?? r.articleCover,
      coverType: (r.articleCoverId != null ? coverById.get(r.articleCoverId)?.type : null) ?? null,
    },
  }));

  return { items, page, limit };
}

export type RatingReviewCounts = Record<'Pending' | 'Actioned' | 'Unactioned', number>;

// Queue badge counts grouped by status.
export async function getArticleRatingReviewCounts(db: Kysely<DB>): Promise<RatingReviewCounts> {
  const grouped = await db
    .selectFrom('ArticleRatingReview')
    .select((eb) => ['ArticleRatingReview.status', eb.fn.countAll<number>().as('count')])
    .groupBy('ArticleRatingReview.status')
    .execute();

  const counts: RatingReviewCounts = { Pending: 0, Actioned: 0, Unactioned: 0 };
  for (const row of grouped) {
    if (row.status === 'Pending') counts.Pending = Number(row.count);
    else if (row.status === 'Actioned') counts.Actioned = Number(row.count);
    else if (row.status === 'Unactioned') counts.Unactioned = Number(row.count);
  }
  return counts;
}

// Content-derived nsfwLevel from cover + content images + moderation floor, mirroring the main app's
// `computeArticleDerivedNsfwLevel`. Reads committed image/report state (which our resolve write doesn't
// touch). Returns null if the article row is missing, 0 for a text-only/no-signal article, else the bitwise
// level. Snapshotted as `moderatorNsfwLevelBasis`.
export async function computeArticleDerivedNsfwLevel(
  db: Kysely<DB>,
  articleId: number
): Promise<number | null> {
  const result = await sql<{ derived: number | null }>`
    WITH level AS (
      SELECT
        a.id,
        GREATEST(
          COALESCE(max(cover."nsfwLevel"), 0),
          COALESCE(max(content_imgs."nsfwLevel"), 0)
        ) AS "nsfwLevel"
      FROM "Article" a
      LEFT JOIN "Image" cover
        ON a."coverId" = cover.id
        AND cover."ingestion" = 'Scanned'
      LEFT JOIN "ImageConnection" ic
        ON ic."entityId" = a.id
        AND ic."entityType" = 'Article'
      LEFT JOIN "Image" content_imgs
        ON ic."imageId" = content_imgs.id
        AND content_imgs."ingestion" = 'Scanned'
      WHERE a.id = ${articleId}
      GROUP BY a.id
    ),
    moderation_floor AS (
      SELECT
        a.id,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM "EntityModeration" em
            WHERE em."entityType" = 'Article'
              AND em."entityId" = a.id
              AND em.status = 'Succeeded'::"EntityModerationStatus"
              AND (em.blocked = TRUE OR 'nsfw' = ANY(em."triggeredLabels"))
          ) OR EXISTS (
            SELECT 1 FROM "ArticleReport" ar
            JOIN "Report" r ON r.id = ar."reportId"
            WHERE ar."articleId" = a.id
              AND r.reason = 'NSFW'::"ReportReason"
              AND r.status = 'Actioned'::"ReportStatus"
          ) THEN 4
          ELSE 0
        END AS "floor"
      FROM "Article" a
      WHERE a.id = ${articleId}
    )
    SELECT GREATEST(level."nsfwLevel", mf."floor") AS derived
    FROM level
    JOIN moderation_floor mf ON mf.id = level.id
  `.execute(db);

  if (result.rows.length === 0) return null;
  return result.rows[0]?.derived ?? 0;
}

export type PendingArticleRatingReview = {
  articleId: number;
  userId: number;
  currentLevel: number;
  suggestedLevel: number;
};

// The pending review row a resolve operates on (status-guarded). Reads through the passed executor — a `trx`
// when participating in the resolve transaction (read-your-writes), else a read client.
export function getArticleRatingReviewForResolve(db: Kysely<DB>, reviewId: number) {
  return db
    .selectFrom('ArticleRatingReview')
    .select(['articleId', 'userId', 'currentLevel', 'suggestedLevel'])
    .where('id', '=', reviewId)
    .where('status', '=', 'Pending')
    .executeTakeFirst();
}

// Close the review: stamp status/resolver/appliedLevel/modComment. Status-guarded on Pending so a racing
// moderator can't double-resolve — the caller treats numUpdatedRows !== 1 as a lost race. Runs on the passed
// executor — a `trx` when part of the resolve transaction, else a write client.
export function setArticleRatingReviewResolved(
  db: Kysely<DB>,
  input: {
    reviewId: number;
    status: RatingReviewStatus;
    appliedLevel: number;
    modComment?: string;
    moderatorId: number;
  }
) {
  return db
    .updateTable('ArticleRatingReview')
    .set({
      status: input.status,
      resolvedAt: new Date(),
      resolvedBy: input.moderatorId,
      appliedLevel: input.appliedLevel,
      modComment: input.modComment ?? null,
    })
    .where('id', '=', input.reviewId)
    .where('status', '=', 'Pending')
    .executeTakeFirst();
}

export type ArticleLockState = {
  lockedProperties: string[];
  title: string;
};

// The article's current lock set + title (needed to merge in the `userNsfwLevel` lock and label the caller's
// notification). Reads through the passed executor — a `trx` inside the resolve transaction, else a read
// client.
export function getArticleLockState(db: Kysely<DB>, articleId: number) {
  return db
    .selectFrom('Article')
    .select(['lockedProperties', 'title'])
    .where('id', '=', articleId)
    .executeTakeFirst();
}

// Pin the article at the moderator override: write moderatorNsfwLevel + the snapshotted basis, force
// nsfwLevel to the applied level (the override wins unconditionally, so no recompute), and persist the merged
// locked-properties set. `lockedProperties` is a Postgres text[] (not jsonb), so the plain array is correct.
export function setArticleModeratorLevel(
  db: Kysely<DB>,
  input: {
    articleId: number;
    appliedLevel: number;
    basis: number;
    lockedProperties: string[];
  }
) {
  return db
    .updateTable('Article')
    .set({
      moderatorNsfwLevel: input.appliedLevel,
      moderatorNsfwLevelBasis: input.basis,
      nsfwLevel: input.appliedLevel,
      lockedProperties: input.lockedProperties,
    })
    .where('id', '=', input.articleId)
    .execute();
}

export type ResolveResult = {
  articleId: number;
  ownerUserId: number;
  previousLevel: number;
  status: RatingReviewStatus;
  articleTitle: string;
};

// DB write core of the moderator app's `resolveArticleRatingReview`, minus its side effects (recordModActivity,
// search-index, analytics, owner notification — all left to the caller). Orchestrates the statement functions
// above in one write transaction on the passed executor. `computeArticleDerivedNsfwLevel` is called internally
// on `db` (reads committed image/report state, which this write doesn't touch) to snapshot the basis.
export function resolveArticleRatingReview(
  db: Kysely<DB>,
  input: {
    reviewId: number;
    appliedLevel: number;
    modComment?: string;
    moderatorId: number;
  }
): Promise<ResolveResult> {
  const { reviewId, appliedLevel, modComment, moderatorId } = input;

  return db.transaction().execute(async (trx) => {
    const review = await getArticleRatingReviewForResolve(trx, reviewId);
    if (!review) throw new Error('Review already resolved');

    // Actioned = the applied level matches the owner's suggestion (granted); Unactioned = the mod applied a
    // different level (overrode). Both pin the override either way.
    const status: RatingReviewStatus =
      appliedLevel === review.suggestedLevel ? 'Actioned' : 'Unactioned';

    const claim = await setArticleRatingReviewResolved(trx, {
      reviewId,
      status,
      appliedLevel,
      modComment,
      moderatorId,
    });
    if (Number(claim.numUpdatedRows) !== 1) throw new Error('Review already resolved');

    const article = await getArticleLockState(trx, review.articleId);

    const locked = new Set<string>(article?.lockedProperties ?? []);
    locked.add('userNsfwLevel');

    const basis = (await computeArticleDerivedNsfwLevel(db, review.articleId)) ?? 0;

    await setArticleModeratorLevel(trx, {
      articleId: review.articleId,
      appliedLevel,
      basis,
      lockedProperties: Array.from(locked),
    });

    return {
      articleId: review.articleId,
      ownerUserId: review.userId,
      previousLevel: review.currentLevel,
      status,
      articleTitle: article?.title ?? 'your article',
    };
  });
}
