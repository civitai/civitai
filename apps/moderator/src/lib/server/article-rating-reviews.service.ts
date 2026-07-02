import { sql } from '@civitai/db/kysely';
import { dbRead, dbWrite } from './db';
import { recordModActivity } from './mod-activity';
import { ReportStatus, type RatingReviewStatusFilter } from '$lib/article-rating-review';
import type { MediaType } from '$lib/media/edge-url';

export type RatingReviewUser = {
  id: number;
  username: string | null;
  image: string | null;
};

export type RatingReviewRow = {
  id: number;
  createdAt: Date | null;
  resolvedAt: Date | null;
  status: ReportStatus;
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
    coverType: MediaType | null;
  };
};

type RawRow = {
  id: number;
  createdAt: Date | null;
  resolvedAt: Date | null;
  status: ReportStatus;
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

export async function getArticleRatingReviews({
  status,
  page = 1,
  limit = 20,
}: {
  status: RatingReviewStatusFilter;
  page?: number;
  limit?: number;
}): Promise<{ items: RatingReviewRow[]; page: number; limit: number }> {
  const offset = (page - 1) * limit;

  const rows = (await dbRead
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

  // Resolve covers from coverId (the legacy `Article.cover` string is null for current articles).
  const coverIds = [
    ...new Set(rows.map((r) => r.articleCoverId).filter((v): v is number => v != null)),
  ];
  const covers = coverIds.length
    ? await dbRead
        .selectFrom('Image')
        .select(['id', 'url', 'type'])
        .where('id', 'in', coverIds)
        .execute()
    : [];
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

export async function getArticleRatingReviewCounts(): Promise<RatingReviewCounts> {
  const grouped = await dbRead
    .selectFrom('ArticleRatingReview')
    .select((eb) => ['ArticleRatingReview.status', eb.fn.countAll<number>().as('count')])
    .groupBy('ArticleRatingReview.status')
    .execute();

  const counts: RatingReviewCounts = { Pending: 0, Actioned: 0, Unactioned: 0 };
  for (const row of grouped) {
    if (row.status === ReportStatus.Pending) counts.Pending = Number(row.count);
    else if (row.status === ReportStatus.Actioned) counts.Actioned = Number(row.count);
    else if (row.status === ReportStatus.Unactioned) counts.Unactioned = Number(row.count);
  }
  return counts;
}

// Content-derived nsfwLevel from cover + content images + moderation floor, mirroring the main app's
// `computeArticleDerivedNsfwLevel`. Runs on the read replica (it reads committed image/report state,
// which our resolve write doesn't touch). Returns null if the article row is missing, 0 for a
// text-only/no-signal article, else the bitwise level. Snapshotted as `moderatorNsfwLevelBasis`.
export async function computeArticleDerivedNsfwLevel(articleId: number): Promise<number | null> {
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
  `.execute(dbRead);

  if (result.rows.length === 0) return null;
  return result.rows[0]?.derived ?? 0;
}

export type ResolveResult = {
  articleId: number;
  ownerUserId: number;
  previousLevel: number;
  status: ReportStatus;
  articleTitle: string;
};

// Moderator resolution — ported from the main app's `resolveArticleRatingReview`. Pins the article at
// `appliedLevel` via a moderator override: the review row is closed (status-guarded so racing mods
// can't double-resolve), `userNsfwLevel` is locked, and the content-derived basis is snapshotted so a
// later down-direction dispute can only auto-clear the override if content genuinely drops below it.
// Because the override wins unconditionally (COALESCE(moderatorNsfwLevel, ...)), we write `nsfwLevel`
// directly rather than running the full recompute. Search-index + analytics + the (deferred) owner
// notification are handled by the caller.
export async function resolveArticleRatingReview(input: {
  reviewId: number;
  appliedLevel: number;
  modComment?: string;
  moderatorId: number;
}): Promise<ResolveResult> {
  const { reviewId, appliedLevel, modComment, moderatorId } = input;

  const result = await dbWrite.transaction().execute(async (trx) => {
    const review = await trx
      .selectFrom('ArticleRatingReview')
      .select(['articleId', 'userId', 'currentLevel', 'suggestedLevel'])
      .where('id', '=', reviewId)
      .where('status', '=', ReportStatus.Pending)
      .executeTakeFirst();
    if (!review) throw new Error('Review already resolved');

    // Actioned = the applied level matches the owner's suggestion (granted); Unactioned = the mod
    // applied a different level (overrode). Both pin the override either way.
    const status =
      appliedLevel === review.suggestedLevel ? ReportStatus.Actioned : ReportStatus.Unactioned;

    const claim = await trx
      .updateTable('ArticleRatingReview')
      .set({
        status,
        resolvedAt: new Date(),
        resolvedBy: moderatorId,
        appliedLevel,
        modComment: modComment ?? null,
      })
      .where('id', '=', reviewId)
      .where('status', '=', ReportStatus.Pending)
      .executeTakeFirst();
    // Lost the race to a concurrent resolve — bail without mutating the article.
    if (Number(claim.numUpdatedRows) !== 1) throw new Error('Review already resolved');

    const article = await trx
      .selectFrom('Article')
      .select(['lockedProperties', 'title'])
      .where('id', '=', review.articleId)
      .executeTakeFirst();

    const locked = new Set<string>(article?.lockedProperties ?? []);
    locked.add('userNsfwLevel');

    const basis = (await computeArticleDerivedNsfwLevel(review.articleId)) ?? 0;

    await trx
      .updateTable('Article')
      .set({
        moderatorNsfwLevel: appliedLevel,
        moderatorNsfwLevelBasis: basis,
        nsfwLevel: appliedLevel,
        lockedProperties: Array.from(locked),
      })
      .where('id', '=', review.articleId)
      .execute();

    return {
      articleId: review.articleId,
      ownerUserId: review.userId,
      previousLevel: review.currentLevel,
      status,
      articleTitle: article?.title ?? 'your article',
    };
  });

  await recordModActivity({
    userId: moderatorId,
    entityType: 'article',
    entityId: result.articleId,
    activity: 'ratingReview',
  });

  return result;
}
