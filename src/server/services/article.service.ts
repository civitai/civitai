import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { ManipulateType } from 'dayjs';
import { truncate } from 'lodash-es';
import type { NsfwLevel } from '~/server/common/enums';
import { ImageConnectionType, NotificationCategory } from '~/server/common/enums';
import { ArticleSort, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { getDbWithoutLag, preventReplicationLag } from '~/server/db/db-lag-helpers';
import { eventEngine } from '~/server/events';
import { userArticleCountCache, articleStatCache } from '~/server/redis/caches';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_KEYS, redis } from '~/server/redis/client';
import { CacheTTL } from '~/server/common/constants';
import type {
  ArticleCursor,
  ArticleMetadata,
  CreateArticleRatingReviewInput,
  GetArticleRatingReviewsInput,
  GetInfiniteArticlesSchema,
  GetModeratorArticlesSchema,
  ResolveArticleRatingReviewInput,
  UpsertArticleInput,
} from '~/server/schema/article.schema';
import { articleWhereSchema } from '~/server/schema/article.schema';
import type { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import {
  browsingLevels,
  getBrowsingLevelLabel,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { articlesSearchIndex } from '~/server/search-index';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { imageSelect, profileImageSelect } from '~/server/selectors/image.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { deriveArticleIngestionState } from '~/server/services/article-ingestion.helpers';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import {
  createImage,
  deleteImageById,
  enqueueImageIngestion,
} from '~/server/services/image.service';
import { getCategoryTags } from '~/server/services/system-cache';
import { amIBlockedByUser } from '~/server/services/user.service';
import { isImageOwner } from '~/server/services/util.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import type { CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';
import {
  ArticleEngagementType,
  ArticleIngestionStatus,
  ArticleStatus,
  Availability,
  EntityModerationStatus,
  ImageIngestionStatus,
  MetricTimeframe,
  TagTarget,
} from '~/shared/utils/prisma/enums';
import { decreaseDate } from '~/utils/date-helpers';
import { postgresSlugify, removeTags } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { getFilesByEntity } from './file.service';
import { generateJSON } from '@tiptap/html/server';
import { tiptapExtensions } from '~/shared/tiptap/extensions';
import { getContentMedia } from '~/server/services/article-content-cleanup.service';
import { createNotification } from '~/server/services/notification.service';
import { updateArticleNsfwLevels } from '~/server/services/nsfwLevels.service';
import { submitTextModeration } from '~/server/services/text-moderation.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { ReportStatus } from '~/shared/utils/prisma/enums';
import {
  AutoResolveRaceLost,
  autoResolveArticleRatingReview,
  computeArticleDerivedNsfwLevel,
  evaluateAutoApproveGate,
  maybeAutoResolveDisputeAfterScan,
  shouldRestampOverrideBasis,
} from '~/server/services/article-rating-review.helpers';

type ArticleRaw = {
  id: number;
  cover?: string | null;
  coverId?: number | null;
  title: string;
  publishedAt: Date | null;
  userNsfwLevel: number;
  nsfwLevel: number;
  availability: Availability;
  userId: number | null;
  status: ArticleStatus;
  tags: {
    tag: {
      id: number;
      name: string;
      isCategory: boolean;
    };
  }[];
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string | null;
    profilePictureId?: number | null;
  };
  userCosmetics: {
    data: Prisma.JsonValue;
    cosmetic: {
      data: Prisma.JsonValue;
      type: CosmeticType;
      id: number;
      name: string;
      source: CosmeticSource;
    };
  }[];
  cosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
};

const getArticleStatsObject = async (data: { id: number }[]) => {
  try {
    return await articleStatCache.fetch(data.map((d) => d.id));
  } catch (e) {
    const error = e as Error;
    logToAxiom(
      {
        type: 'error',
        name: 'Failed to getArticleStats',
        message: error.message,
        stack: error.stack,
        cause: error.cause,
      },
      'article-stats'
    ).catch();
    return {};
  }
};

export type ArticleGetAllRecord = Awaited<ReturnType<typeof getArticles>>['items'][number];

export type ArticleGetAll = AsyncReturnType<typeof getArticles>['items'];
export const getArticles = async ({
  limit,
  cursor,
  query,
  tags,
  period,
  periodMode,
  sort,
  sessionUser,
  excludedIds,
  excludedUserIds,
  excludedTagIds,
  userIds,
  favorites,
  hidden,
  username,
  includeDrafts,
  ids,
  collectionId,
  followed,
  pending,
  browsingLevel,
  include,
  forceHidePrivate,
}: GetInfiniteArticlesSchema & {
  sessionUser?: { id: number; isModerator?: boolean; username?: string };
  include?: Array<'cosmetics'>;
  // When true, `availability = Private` articles are ALWAYS dropped, even when a
  // `username`/`collectionId`/etc. filter is set (which normally expands the result
  // set to include the caller's private articles). Used by the public REST surface
  // so an anonymous `?username=X` request can never surface a user's private
  // articles. Defaults to false → the website/tRPC path is unchanged.
  forceHidePrivate?: boolean;
}) => {
  const userId = sessionUser?.id;
  const isModerator = sessionUser?.isModerator ?? false;
  const includeCosmetics = !!include?.includes('cosmetics');
  try {
    const take = limit + 1;
    const isMod = sessionUser?.isModerator ?? false;
    const isOwnerRequest =
      !!sessionUser?.username &&
      postgresSlugify(sessionUser.username) === postgresSlugify(username);
    const hidePrivateArticles =
      forceHidePrivate ||
      (!ids && !username && !collectionId && !followed && !hidden && !favorites && !userIds);

    const AND: Prisma.Sql[] = [];

    if (query) {
      AND.push(Prisma.sql`a."title" ILIKE ${'%' + query + '%'}`);
    }
    if (!!tags?.length) {
      AND.push(
        Prisma.sql`EXISTS (
          SELECT 1 FROM "TagsOnArticle" toa WHERE toa."articleId" = a.id AND toa."tagId" IN (${Prisma.join(
            tags,
            ','
          )})
        )`
      );
    }

    if (!!userIds?.length) {
      AND.push(Prisma.sql`a."userId" IN (${Prisma.join(userIds, ',')})`);
    }
    if (!!ids?.length) {
      AND.push(Prisma.sql`a.id IN (${Prisma.join(ids, ',')})`);
    }

    if (browsingLevel) {
      if (pending && (isModerator || userId)) {
        if (isModerator) {
          AND.push(Prisma.sql`((a."nsfwLevel" & ${browsingLevel}) != 0 OR a."nsfwLevel" = 0)`);
        } else if (userId) {
          AND.push(
            Prisma.sql`((a."nsfwLevel" & ${browsingLevel}) != 0 OR (a."nsfwLevel" = 0 AND a."userId" = ${userId}))`
          );
        }
      } else {
        AND.push(Prisma.sql`(a."nsfwLevel" & ${browsingLevel}) != 0`);
      }
    }

    if (username) {
      const userFindArgs = { where: { username: username ?? '' }, select: { id: true } };
      const targetUser =
        (await dbRead.user.findUnique(userFindArgs)) ??
        (await dbWrite.user.findUnique(userFindArgs));

      if (!targetUser) throw throwNotFoundError('User not found');

      AND.push(Prisma.sql`u.id = ${targetUser.id}`);
    }

    if (collectionId) {
      const permissions = await getUserCollectionPermissionsById({
        userId: sessionUser?.id,
        id: collectionId,
      });

      if (!permissions.read) {
        return { items: [] };
      }

      const { rawAND: collectionItemModelsRawAND } = getAvailableCollectionItemsFilterForUser({
        permissions,
        userId: sessionUser?.id,
      });

      AND.push(
        Prisma.sql`EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        WHERE ci."articleId" = a."id"
        AND ci."collectionId" = ${collectionId}
        AND ${Prisma.join(collectionItemModelsRawAND, ' AND ')})`
      );
    }

    if (!isOwnerRequest) {
      if (!isMod) {
        AND.push(Prisma.sql`a."status" = ${ArticleStatus.Published}::"ArticleStatus"`);
        if (userId) {
          AND.push(
            Prisma.sql`(a."ingestion" = 'Scanned'::"ArticleIngestionStatus" OR a."userId" = ${userId})`
          );
        } else {
          AND.push(Prisma.sql`a."ingestion" = 'Scanned'::"ArticleIngestionStatus"`);
        }
      }
      if (!!excludedUserIds?.length) {
        AND.push(Prisma.sql`a."userId" != ALL(${excludedUserIds}::int[])`);
      }
      if (!!excludedIds?.length) {
        AND.push(Prisma.sql`a.id NOT IN (${Prisma.join(excludedIds, ',')})`);
      }
      if (!!excludedTagIds?.length) {
        AND.push(
          Prisma.sql`NOT EXISTS (
            SELECT 1 FROM "TagsOnArticle" toa WHERE toa."articleId" = a.id AND toa."tagId" IN (${Prisma.join(
              excludedTagIds,
              ','
            )})
          )`
        );
      }
    }

    if (sessionUser) {
      if (favorites) {
        AND.push(
          Prisma.sql`EXISTS (
            SELECT 1 FROM "ArticleEngagement" ae WHERE ae."articleId" = a.id AND ae."userId" = ${sessionUser?.id} AND ae."type" = ${ArticleEngagementType.Favorite}::"ArticleEngagementType"
          )`
        );
      } else if (hidden) {
        AND.push(
          Prisma.sql`EXISTS (
            SELECT 1 FROM "ArticleEngagement" ae WHERE ae."articleId" = a.id AND ae."userId" = ${sessionUser?.id} AND ae."type" = ${ArticleEngagementType.Hide}::"ArticleEngagementType"
          )`
        );
      }
    }

    // Filter only followed users
    if (!!sessionUser && followed) {
      const followedUsers = await dbRead.user.findUnique({
        where: { id: sessionUser.id },
        select: {
          engagingUsers: {
            select: { targetUser: { select: { id: true } } },
            where: { type: 'Follow' },
          },
        },
      });
      const followedUsersIds =
        followedUsers?.engagingUsers?.map(({ targetUser }) => targetUser.id) ?? [];

      AND.push(Prisma.sql`a."userId" IN (${Prisma.join(followedUsersIds, ',')})`);
    }

    const publishedAtFilter: Prisma.Sql | undefined =
      isMod && includeDrafts
        ? undefined
        : period !== MetricTimeframe.AllTime && periodMode !== 'stats'
        ? Prisma.sql`a."publishedAt" >= ${decreaseDate(
            new Date(),
            1,
            period.toLowerCase() as ManipulateType
          )}`
        : Prisma.sql`a."publishedAt" IS NOT NULL AND a.status = 'Published'::"ArticleStatus"`;

    if (publishedAtFilter) {
      AND.push(publishedAtFilter);
    }

    // --- Sort & keyset-pagination setup ---
    //
    // `sortExpr` resolves to a non-NULL numeric value: rank columns come from a
    // LEFT JOIN on "ArticleRank" and are NULL for articles with no ranking
    // in the current period (the common case for recently-ingested articles),
    // so we coalesce to INT_MAX so they sort last under ASC instead of
    // terminating the cursor (`nextCursor` used to become `undefined` the
    // moment a page's last row had a NULL rank → feed stopped after page 1).
    //
    // Pagination is a keyset on (sortExpr, a.id DESC). `a.id` is the
    // tiebreaker so pages are deterministic even when many articles share
    // the same sort value (e.g. the INT_MAX sentinel).
    const NULL_RANK_SENTINEL = 2147483647; // max int32 — sorts after any real rank under ASC
    const rankExpr = (col: string) => `COALESCE(rank."${col}${period}Rank", ${NULL_RANK_SENTINEL})`;

    let sortExpr: string;
    let sortDir: 'ASC' | 'DESC';
    switch (sort) {
      case ArticleSort.MostBookmarks:
      case ArticleSort.MostCollected:
        sortExpr = rankExpr('collectedCount');
        sortDir = 'ASC';
        break;
      case ArticleSort.MostComments:
        sortExpr = rankExpr('commentCount');
        sortDir = 'ASC';
        break;
      case ArticleSort.MostReactions:
        sortExpr = rankExpr('reactionCount');
        sortDir = 'ASC';
        break;
      case ArticleSort.RecentlyUpdated:
        sortExpr = `extract(epoch from a."updatedAt")`;
        sortDir = 'DESC';
        break;
      case ArticleSort.Newest:
      default:
        sortExpr = `extract(epoch from a."publishedAt")`;
        sortDir = 'DESC';
        break;
    }

    const sortExprSql = Prisma.raw(sortExpr);
    const orderBy = Prisma.sql`${sortExprSql} ${Prisma.raw(sortDir)}, a.id DESC`;

    if (cursor) {
      // Keyset predicate: include the cursor row itself — it's the lookahead
      // row from the previous page, intended to anchor this page. Tiebreaker
      // is always id DESC, so on a sortExpr tie we accept ids <= cursor.id
      // (rows with id > cursor.id were already returned on the previous page).
      const primaryOp = Prisma.raw(sortDir === 'DESC' ? '<' : '>');
      AND.push(Prisma.sql`(
        ${sortExprSql} ${primaryOp} ${cursor.v}
        OR (${sortExprSql} = ${cursor.v} AND a.id <= ${cursor.id})
      )`);
    }

    const queryFrom = Prisma.sql`
      FROM "Article" a
      LEFT JOIN "User" u ON a."userId" = u.id
      LEFT JOIN "ArticleRank" rank ON rank."articleId" = a.id
      WHERE ${Prisma.join(AND, ' AND ')}
    `;
    const articles = await dbRead.$queryRaw<(ArticleRaw & { cursorV: number })[]>`
      SELECT
        a.id,
        a.cover,
        a."coverId",
        a.title,
        a."publishedAt",
        a."nsfwLevel",
        a."userNsfwLevel",
        a."userId",
        a."createdAt",
        a."updatedAt",
        a."unlisted",
        a."availability",
        a."userId",
        a.status,
        (
          SELECT COALESCE(
            jsonb_agg(
                jsonb_build_object('tag', jsonb_build_object(
                  'id', t.id,
                  'name', t.name,
                  'isCategory', t."isCategory"
                ))
            ), '[]'::jsonb
          ) FROM "TagsOnArticle" at
            JOIN "Tag" t ON t.id = at."tagId"
            WHERE at."articleId" = a."id"
            AND "tagId" IS NOT NULL
        ) as "tags",
        jsonb_build_object(
          'id', u."id",
          'username', u."username",
          'deletedAt', u."deletedAt",
          'image', u."image",
          'profilePictureId', u."profilePictureId"
        ) as "user",
        (
          SELECT
            jsonb_agg(
              jsonb_build_object(
                'data', uc.data,
                'cosmetic', jsonb_build_object(
                  'id', c.id,
                  'data', c.data,
                  'type', c.type,
                  'source', c.source,
                  'name', c.name,
                  'leaderboardId', c."leaderboardId",
                  'leaderboardPosition', c."leaderboardPosition"
                )
              )
            )
          FROM "UserCosmetic" uc
          JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
              AND "equippedAt" IS NOT NULL
          WHERE uc."userId" = a."userId" AND uc."equippedToId" IS NULL
          GROUP BY uc."userId"
        ) as "userCosmetics",
        ${sortExprSql} as "cursorV"
      ${queryFrom}
      ORDER BY ${orderBy}
      LIMIT ${take}
    `;

    let nextCursor: ArticleCursor | undefined;
    if (articles.length > limit) {
      const nextItem = articles.pop();
      if (nextItem) nextCursor = { v: Number(nextItem.cursorV), id: nextItem.id };
    }

    const profilePictures = await dbRead.image.findMany({
      where: { id: { in: articles.map((a) => a.user.profilePictureId).filter(isDefined) } },
      select: { ...profileImageSelect, ingestion: true },
    });

    const coverIds = articles.map((x) => x.coverId).filter(isDefined);
    const coverImages = coverIds.length
      ? await dbRead.image.findMany({
          where: { id: { in: coverIds } },
          select: imageSelect,
        })
      : [];

    const articleCategories = await getCategoryTags('article');
    const cosmetics = includeCosmetics
      ? await getCosmeticsForEntity({ ids: articles.map((x) => x.id), entity: 'Article' })
      : {};

    // Fetch article stats separately
    const articleStats = await getArticleStatsObject(articles);

    const items = articles
      .filter((a) => {
        // This take prio over mod status just so mods can see the same as users.
        if (hidePrivateArticles && a.availability === Availability.Private) return false;
        if (sessionUser?.isModerator || a.userId === sessionUser?.id) return true;

        return true;
      })
      .map(({ tags, user, userCosmetics, cursorV, ...article }) => {
        const { profilePictureId, ...u } = user;
        const profilePicture = profilePictures.find((p) => p.id === profilePictureId) ?? null;
        const coverImage = coverImages.find((x) => x.id === article.coverId);
        const match = articleStats[article.id];

        return {
          ...article,
          tags: tags.map(({ tag }) => ({
            ...tag,
            isCategory: articleCategories.some((c) => c.id === tag.id),
          })),
          stats: match
            ? {
                favoriteCount: match.favoriteCount ?? 0,
                collectedCount: match.collectedCount ?? 0,
                commentCount: match.commentCount ?? 0,
                likeCount: match.likeCount ?? 0,
                dislikeCount: match.dislikeCount ?? 0,
                heartCount: match.heartCount ?? 0,
                laughCount: match.laughCount ?? 0,
                cryCount: match.cryCount ?? 0,
                viewCount: match.viewCount ?? 0,
                tippedAmountCount: match.tippedAmountCount ?? 0,
              }
            : undefined,
          user: {
            ...u,
            profilePicture,
            cosmetics: userCosmetics,
          },
          coverImage: coverImage
            ? {
                ...coverImage,
                // Lift the cover image nsfwLevel to the article's aggregate so card-level NSFW filtering (ImageGuard blur, browsingLevel mask) reflects content images or userNsfwLevel that may have raised the rating above the cover's own level.
                nsfwLevel: Math.max(article.nsfwLevel ?? 0, coverImage.nsfwLevel ?? 0),
                meta: coverImage.meta as ImageMetaProps,
                metadata: coverImage.metadata as ImageMetadata,
                tags: coverImage?.tags.flatMap((x) => x.tag.id),
              }
            : undefined,
          cosmetic: cosmetics[article.id] ?? null,
        };
      });

    return {
      nextCursor,
      items: items as Array<
        Omit<(typeof items)[number], 'cosmetic'> & {
          cosmetic?: WithClaimKey<ContentDecorationCosmetic> | null;
        }
      >,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

type CivitaiNewsItemRaw = {
  id: number;
  collection: string;
  coverId?: number;
  title: string;
  content: string;
  publishedAt: Date;
  userId: number;
  featured: boolean;
  summary?: string;
};
export type CivitaiNewsItem = AsyncReturnType<typeof getCivitaiNews>['articles'][number];
export const getCivitaiNews = async () => {
  const articlesRaw = await dbRead.$queryRaw<CivitaiNewsItemRaw[]>`
    SELECT
      c.name as "collection",
      a.id,
      "coverId",
      title,
      content,
      "publishedAt",
      a."userId",
      COALESCE(a.metadata->>'featured' = 'true', false) AS featured,
      a.metadata->>'summary' AS summary
    FROM "Article" a
    JOIN "CollectionItem" ci ON ci."articleId" = a.id
    JOIN "Collection" c ON c.id = ci."collectionId"
    WHERE c.name IN ('Newsroom', 'Updates') AND c."userId" = -1 AND a."createdAt" > now() - '1 year'::interval
      AND a."publishedAt" IS NOT NULL AND a.status = 'Published'::"ArticleStatus"
      AND a."ingestion" = 'Scanned'::"ArticleIngestionStatus"
      AND (a."nsfwLevel" & ${publicBrowsingLevelsFlag}) != 0
    ORDER BY a."createdAt" DESC
    LIMIT 10
  `;
  const userIds = new Set(articlesRaw.map((x) => x.userId));
  const users = await dbRead.user.findMany({
    where: { id: { in: [...userIds] } },
    select: userWithCosmeticsSelect,
  });

  const coverIds = articlesRaw.map((x) => x.coverId).filter(isDefined);
  const coverImages = coverIds.length
    ? await dbRead.image.findMany({
        where: { id: { in: coverIds } },
        select: imageSelect,
      })
    : [];

  const articles = articlesRaw.map((article) => {
    const user = users.find((x) => x.id === article.userId);
    const coverImage = coverImages.find((x) => x.id === article.coverId);
    return {
      ...article,
      user: user ?? null,
      summary: article.summary ?? truncate(removeTags(article.content), { length: 200 }),
      coverImage: coverImage
        ? { ...coverImage, tags: coverImage?.tags.flatMap((x) => x.tag.id) }
        : undefined,
      type: article.collection === 'Newsroom' ? 'news' : 'updates',
    };
  });

  const pressMentions = await dbRead.pressMention.findMany({
    orderBy: { publishedAt: 'desc' },
    where: { publishedAt: { lte: new Date() } },
  });

  return { articles, pressMentions };
};

export const getCivitaiEvents = async () => {
  const collection = await dbRead.collection.findFirst({
    where: { name: 'Events', userId: -1 },
    select: { id: true },
  });
  if (!collection) throw new Error('Events collection not found');

  const input = articleWhereSchema.parse({
    collectionId: collection.id,
    sort: ArticleSort.Newest,
  });
  const events = await getArticles({
    ...input,
    limit: 100,
    sessionUser: undefined,
    browsingLevel: publicBrowsingLevelsFlag,
  });
  return events;
};

export type ArticleGetById = AsyncReturnType<typeof getArticleById>;
export const getArticleById = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId?: number; isModerator?: boolean }) => {
  try {
    const db = await getDbWithoutLag('article', id);
    const article = await db.article.findFirst({
      where: {
        id,
        OR: !isModerator
          ? [
              {
                publishedAt: { not: null },
                status: ArticleStatus.Published,
                ingestion: ArticleIngestionStatus.Scanned,
              },
              { userId },
            ]
          : undefined,
      },
      // Include `moderatorNsfwLevel` here (not in the shared select) so the
      // edit form can render the override banner / picker. The public article
      // read payload is served by `getArticles`, not this function, so the
      // field doesn't flow into external webhook / search-index payloads.
      select: { ...articleDetailSelect, moderatorNsfwLevel: true },
    });

    if (!article) throw throwNotFoundError(`No article with id ${id}`);
    if (userId && !isModerator) {
      const blocked = await amIBlockedByUser({ userId, targetUserId: article.userId });
      if (blocked) throw throwNotFoundError(`No article with id ${id}`);
    }

    // Fetch connected images with ingestion status
    const imageConnections = await dbRead.imageConnection.findMany({
      where: { entityId: id, entityType: ImageConnectionType.Article },
      include: {
        image: {
          select: { id: true, url: true, ingestion: true },
        },
      },
    });

    const articleCategories = await getCategoryTags('article');
    const attachments: Awaited<ReturnType<typeof getFilesByEntity>> = await getFilesByEntity({
      id,
      type: 'Article',
    });

    const coverImage = article.coverImage
      ? {
          ...article.coverImage,
          nsfwLevel: article.coverImage.nsfwLevel as NsfwLevel,
          meta: article.coverImage.meta as ImageMetaProps,
          metadata: article.coverImage.metadata as ImageMetadata,
          tags: article.coverImage?.tags.flatMap((x) => x.tag.id),
        }
      : undefined;

    const canViewCoverImage =
      isModerator ||
      userId === article.userId ||
      (coverImage?.ingestion === 'Scanned' && !coverImage?.needsReview);

    let contentJson: MixedObject | undefined;
    if (article.content) {
      contentJson = article.content.startsWith('{')
        ? JSON.parse(article.content)
        : generateJSON(article.content, tiptapExtensions);
    }

    return {
      ...article,
      nsfwLevel: article.nsfwLevel as NsfwLevel,
      attachments,
      tags: article.tags.map(({ tag }) => ({
        ...tag,
        isCategory: articleCategories.some((c) => c.id === tag.id),
      })),
      coverImage: canViewCoverImage ? coverImage : undefined,
      contentJson,
      contentImages: imageConnections.map((conn) => conn.image),
      metadata: (article.metadata as ArticleMetadata) ?? null,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const upsertArticle = async ({
  id,
  userId,
  tags,
  attachments,
  coverImage,
  isModerator,
  scanContent,
  ...data
}: UpsertArticleInput & {
  userId: number;
  isModerator?: boolean;
  metadata?: ArticleMetadata;
  scanContent?: boolean;
}) => {
  try {
    await throwOnBlockedLinkDomain(data.content);
    if (!isModerator) {
      // don't allow updating of locked properties
      for (const key of data.lockedProperties ?? []) delete data[key as keyof typeof data];
      // moderatorNsfwLevel is a mod-only field. Silently strip it from
      // non-moderator payloads rather than throwing: the form never exposes
      // this control to owners, so a client sending it indicates either a
      // stale client or an attempt to forge the override — either way, drop.
      delete data.moderatorNsfwLevel;
    }

    // For updates, fetch article early so we can check cover image ownership and NSFW level
    let article: {
      id: number;
      title: string;
      cover: string | null;
      coverId: number | null;
      userId: number;
      publishedAt: Date | null;
      status: string;
      nsfwLevel: number;
      userNsfwLevel: number;
      moderatorNsfwLevel: number | null;
      lockedProperties: string[];
      metadata: Prisma.JsonValue;
      content: string | null;
    } | null = null;
    if (id) {
      article = await dbWrite.article.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          cover: true,
          coverId: true,
          userId: true,
          publishedAt: true,
          status: true,
          nsfwLevel: true,
          userNsfwLevel: true,
          moderatorNsfwLevel: true,
          lockedProperties: true,
          metadata: true,
          content: true,
        },
      });
      if (!article) throw throwNotFoundError();
      const isOwner = article.userId === userId || isModerator;
      if (!isOwner) throw throwAuthorizationError('You cannot perform this action');
    }

    // TODO make coverImage required here and in db
    // create image entity to be attached to article
    let coverId = coverImage?.id;
    if (coverImage) {
      if (!coverId) {
        const result = await createImage({ ...coverImage, userId });
        coverId = result.id;
      } else {
        // Skip ownership check when the cover image hasn't changed (e.g. mod-uploaded covers)
        const isExistingCover = article != null && coverId === article.coverId;
        if (!isExistingCover) {
          const isImgOwner = await isImageOwner({ userId, isModerator, imageId: coverId });
          if (!isImgOwner) {
            throw throwAuthorizationError('Invalid cover image');
          }
        }
      }
    }

    if (!id) {
      // Set publishedAt based on status
      // - Published: Set to now (appears at top of feed)
      // - Processing: Don't set yet (will be set when scan completes)
      // - Draft/Other: Don't set
      let publishedAt: Date | null | undefined = undefined;
      if (data.status === ArticleStatus.Published) {
        publishedAt = new Date();
      } else if (data.status === ArticleStatus.Processing) {
        publishedAt = null;
      }

      const result = await dbWrite.$transaction(async (tx) => {
        const article = await tx.article.create({
          data: {
            ...data,
            publishedAt,
            coverId,
            userId,
            tags: tags
              ? {
                  create: tags.map((tag) => {
                    const name = tag.name.toLowerCase().trim();
                    return {
                      tag: {
                        connectOrCreate: {
                          where: { name },
                          create: { name, target: [TagTarget.Article] },
                        },
                      },
                    };
                  }),
                }
              : undefined,
          },
        });

        if (attachments) {
          await tx.file.createMany({
            data: attachments.map((attachment) => ({
              ...attachment,
              entityId: article.id,
              entityType: 'Article',
            })),
          });
        }

        return article;
      });

      // Count-cache refresh hits Redis — run after commit, off the txn budget.
      await userArticleCountCache.refresh(result.userId);

      await preventReplicationLag('article', result.id);
      await preventReplicationLag('userArticles', userId);

      // Link content images for new article (creates Image entities and ImageConnections)
      if (result.content && scanContent) {
        try {
          await linkArticleContentImages({
            articleId: result.id,
            content: result.content,
            userId,
            coverId: result.coverId,
          });

          // Mark scan as requested after successfully linking images
          await dbWrite.article.update({
            where: { id: result.id },
            data: { scanRequestedAt: new Date(), ingestion: ArticleIngestionStatus.Pending },
          });
        } catch (e) {
          // Non-blocking: continue even if image linking fails, but log the error
          const error = e as Error;
          logToAxiom({
            type: 'error',
            name: 'article-image-linking',
            message: error.message,
            cause: error.cause,
            stack: error.stack,
            articleId: result.id,
          }).catch();
        }
      }

      // Submit for text moderation (non-blocking, fire-and-forget)
      if (result.content) {
        const textForModeration = [data.title, removeTags(result.content)]
          .filter(Boolean)
          .join(' ');
        submitTextModeration({
          entityType: 'Article',
          entityId: result.id,
          content: textForModeration,
          labels: ['nsfw'],
          recordForReview: true,
        }).catch((e) => {
          logToAxiom({
            type: 'error',
            name: 'article-text-moderation',
            message: (e as Error).message,
            articleId: result.id,
          }).catch();
        });
      }

      return result;
    }

    // article is guaranteed non-null here since the `if (id)` block above fetches it
    if (!article) throw throwNotFoundError();

    // userNsfwLevel is the user's preference and is preserved verbatim. The
    // effective article.nsfwLevel is derived by updateArticleNsfwLevels as
    // GREATEST(userNsfwLevel, cover, content images, moderation floor), so
    // writing a lower userNsfwLevel cannot leak content past filters — the
    // higher signals keep nsfwLevel raised. When those signals later drop
    // (images removed, moderation unactioned), nsfwLevel falls back to the
    // user's original choice instead of being permanently anchored by a
    // prior clamp.

    // Prevent owners from re-publishing articles unpublished for ToS violations
    if (
      article.status === ArticleStatus.UnpublishedViolation &&
      data.status === ArticleStatus.Published &&
      !isModerator
    ) {
      throw throwBadRequestError(
        'This article was unpublished for violating Terms of Service and cannot be republished. Please contact support if you believe this was in error.'
      );
    }

    // SECURITY: Validate image scan status before allowing publish
    // Prevent publishing articles with blocked or failed images
    // Note: Pending images are allowed - article will remain in Processing status until scan completes
    if (!isModerator && data.status === ArticleStatus.Published && scanContent) {
      const scanStatus = await getArticleScanStatus({ id });
      const hasProblematicImages = scanStatus.blocked > 0 || scanStatus.error > 0;

      if (hasProblematicImages) {
        const errorParts: string[] = [];
        if (scanStatus.blocked > 0) {
          errorParts.push(`${scanStatus.blocked} image(s) blocked (policy violation)`);
        }
        if (scanStatus.error > 0) {
          errorParts.push(`${scanStatus.error} image(s) failed to scan`);
        }

        throw throwBadRequestError(
          `Cannot publish article: ${errorParts.join(', ')}. Please remove or replace these images.`
        );
      }
    }

    // moderatorNsfwLevel is the mod override layer that takes precedence over
    // the GREATEST derivation (see updateArticleNsfwLevels). We still need to
    // know when the override changed so the locked-properties set below can
    // pin/unpin userNsfwLevel accordingly — the recompute itself happens
    // unconditionally via updateArticleImageScanStatus post-commit.
    const moderatorOverrideChanged =
      !!isModerator &&
      data.moderatorNsfwLevel !== undefined &&
      data.moderatorNsfwLevel !== article.moderatorNsfwLevel;

    // When a mod sets an override, lock the user's picker so a subsequent
    // owner save can't quietly drift userNsfwLevel underneath it. When the
    // mod clears the override (sets back to null) we unlock the picker and
    // the article returns to auto-derivation on the next recompute. Lock/unlock
    // fires only when the override VALUE changes; the basis snapshot below has
    // its own (broader) trigger.
    let moderatorNsfwLevelBasis: number | null | undefined = undefined;
    if (moderatorOverrideChanged) {
      const lockedSet = new Set<string>(data.lockedProperties ?? article.lockedProperties ?? []);
      if (data.moderatorNsfwLevel != null) lockedSet.add('userNsfwLevel');
      else lockedSet.delete('userNsfwLevel');
      data.lockedProperties = Array.from(lockedSet);
    }
    // (Re)snapshot `moderatorNsfwLevelBasis` — the content-derived level at
    // override time — so the auto-approve gate (#6) can later distinguish a
    // genuine content drop from an override deliberately set above the images
    // (which must not be auto-cleared by an owner dispute). Re-stamp on every
    // moderator assertion of a non-null override (even an unchanged re-affirm),
    // clear it when the override is cleared, and leave it untouched when the
    // field is omitted. NOTE: derived is computed against the CURRENTLY-COMMITTED
    // content — if this same save also changes images, those rescan post-commit,
    // so the basis reflects pre-save content (safe: gate #3 blocks auto-approve
    // until the rescan settles). See shouldRestampOverrideBasis for why
    // aggressive re-stamping is safe.
    if (!!isModerator && data.moderatorNsfwLevel === null) {
      moderatorNsfwLevelBasis = null;
    } else if (
      shouldRestampOverrideBasis({
        isModerator: !!isModerator,
        payloadOverride: data.moderatorNsfwLevel,
        currentOverride: article.moderatorNsfwLevel,
      })
    ) {
      moderatorNsfwLevelBasis = (await computeArticleDerivedNsfwLevel(id as number)) ?? 0;
    }

    const republishing =
      (article.status === ArticleStatus.Unpublished && data.status === ArticleStatus.Published) ||
      !!article.publishedAt;

    const prevMetadata = article.metadata as ArticleMetadata | null;

    // Set publishedAt based on status
    // - Published: Set to now for new articles, preserve for republishing
    // - Processing: Preserve existing publishedAt if article was already published (re-scan scenario)
    // - Unpublished: Preserve publishedAt so republish keeps original date
    // - Draft: Preserve publishedAt — once an article has gone public,
    //   demoting it back to Draft must not erase the original publish date.
    //   Otherwise the next republish satisfies `republishing = !!article.publishedAt === false`
    //   and gets a fresh `new Date()`, surfacing old content at the top of
    //   the Newest feed. Only legitimately never-published rows keep
    //   publishedAt = null (it was already null on read; `article.publishedAt`
    //   passes that through unchanged).
    let publishedAt: Date | null | undefined = undefined;
    if (data.status === ArticleStatus.Published) {
      publishedAt = republishing ? article.publishedAt : new Date();
    } else if (data.status === ArticleStatus.Processing) {
      // Preserve original publishedAt if article was already published (re-scanning scenario)
      // Otherwise set to null for new articles
      publishedAt = article.publishedAt || null;
    } else if (data.status === ArticleStatus.Unpublished) {
      // Preserve publishedAt when unpublishing so republish keeps original date
      publishedAt = article.publishedAt;
    } else if (data.status === ArticleStatus.Draft) {
      publishedAt = article.publishedAt;
    }

    const result = await dbWrite.$transaction(async (tx) => {
      const updated = await tx.article.update({
        where: { id },
        data: {
          ...data,
          ...(moderatorNsfwLevelBasis !== undefined ? { moderatorNsfwLevelBasis } : {}),
          metadata: { ...prevMetadata, ...data.metadata },
          publishedAt,
          coverId,
          tags: tags
            ? {
                deleteMany: {
                  tagId: {
                    notIn: tags.filter(isTag).map((x) => x.id),
                  },
                },
                connectOrCreate: tags.filter(isTag).map((tag) => ({
                  where: { tagId_articleId: { tagId: tag.id, articleId: id as number } },
                  create: { tagId: tag.id },
                })),
                create: tags.filter(isNotTag).map((tag) => {
                  const name = tag.name.toLowerCase().trim();
                  return {
                    tag: {
                      connectOrCreate: {
                        where: { name },
                        create: { name, target: [TagTarget.Article] },
                      },
                    },
                  };
                }),
              }
            : undefined,
        },
      });
      if (!updated) return null;

      if (attachments) {
        // Delete any attachments that were removed.
        await tx.file.deleteMany({
          where: {
            entityId: id,
            entityType: 'Article',
            id: { notIn: attachments.map((x) => x.id).filter(isDefined) },
          },
        });

        // Create any new attachments.
        await tx.file.createMany({
          data: attachments
            .filter((x) => !x.id)
            .map((attachment) => ({
              ...attachment,
              entityId: updated.id,
              entityType: 'Article',
            })),
        });
      }

      return updated;
    });

    if (!result) throw throwNotFoundError(`No article with id ${id}`);

    // Count-cache refresh hits Redis — run after commit, off the txn budget.
    await userArticleCountCache.refresh(result.userId);

    await preventReplicationLag('article', result.id);
    await preventReplicationLag('userArticles', result.userId);

    // remove old cover image
    if (article.coverId !== coverId && article.coverId) {
      const isImgOwner = await isImageOwner({ userId, isModerator, imageId: article.coverId });
      if (isImgOwner) {
        await deleteImageById({ id: article.coverId });
      }
    }

    // Link content images (creates Image entities and ImageConnections)
    if (data.content) {
      // OPTIMIZATION: Only process images if content actually changed
      const hasContentChanged = article.content !== data.content;

      if (hasContentChanged) {
        try {
          const { orphanedImageIds } = await linkArticleContentImages({
            articleId: id,
            content: data.content,
            userId,
            coverId: coverId ?? article.coverId,
            cleanupOnly: !scanContent,
          });

          // Delete truly orphaned images (DB + S3 + cache) post-transaction
          for (const imageId of orphanedImageIds) {
            await deleteImageById({ id: imageId }).catch((error) => {
              handleLogError(error, 'article-orphaned-image-cleanup', {
                articleId: id,
                imageId,
              });
            });
          }

          if (scanContent) {
            // Content changed and images need re-scanning — use Rescan to distinguish
            // user-edit-triggered rescans from initial pending scans.
            await dbWrite.article.update({
              where: { id },
              data: { scanRequestedAt: new Date(), ingestion: ArticleIngestionStatus.Rescan },
            });
          }
        } catch (e) {
          // Non-blocking: continue even if image linking fails, but log the error
          const error = e as Error;
          logToAxiom({
            type: 'error',
            name: 'article-image-linking',
            message: error.message,
            cause: error.cause,
            stack: error.stack,
            articleId: id,
          }).catch();
        }
      }
    }

    // Submit for text moderation (non-blocking). `submitTextModeration` →
    // `createXGuardModerationRequest` handles contentHash dedup internally,
    // so a save that doesn't change `title` or `content` is a no-op
    // orchestrator-wise. If the article's text was emptied out entirely,
    // drop any stale EntityModeration row — otherwise the retry cron would
    // keep re-submitting and `recomputeArticleIngestion` could still read
    // the old blocked/error state.
    {
      const currentTitle = data.title ?? article.title ?? '';
      const currentContent = data.content ?? article.content ?? '';
      const hasText = articleHasText(currentTitle, currentContent);

      if (!hasText) {
        await dbWrite.entityModeration.deleteMany({
          where: { entityType: 'Article', entityId: id },
        });
      } else {
        const textForModeration = [currentTitle, removeTags(currentContent)]
          .filter(Boolean)
          .join(' ');

        submitTextModeration({
          entityType: 'Article',
          entityId: id,
          content: textForModeration,
          labels: ['nsfw'],
          recordForReview: true,
        }).catch((e) => {
          logToAxiom({
            type: 'error',
            name: 'article-text-moderation',
            message: (e as Error).message,
            articleId: id,
          }).catch();
        });
      }
    }

    // Lock ingestion state, recompute nsfwLevel from current cover/content
    // signals, and queue the search-index update. Running the full
    // `updateArticleImageScanStatus` (rather than bare `recomputeArticleIngestion`)
    // guarantees that any edit or publish/republish re-derives
    // `Article.nsfwLevel` from ground truth — otherwise a cover whose scan
    // finished between save and republish would leak at its stale
    // author-declared level. Dispatches the search-index update internally.
    await updateArticleImageScanStatus([id]).catch((e) =>
      handleLogError(e, 'article-update-recompute', { articleId: id })
    );

    // If it was published, process it.
    if (result.publishedAt && result.publishedAt <= new Date()) {
      await eventEngine.processEngagement({
        userId: result.userId,
        type: 'published',
        entityType: 'article',
        entityId: result.id,
      });
    }

    // Tell non-mod owners when a moderator override is currently in force so
    // the client can surface a rescan-warning popover (plan §7b). The
    // override field stays out of the response for mod callers — they have
    // their own controls in the edit UI.
    const hasModeratorOverride =
      !isModerator && article != null && article.moderatorNsfwLevel != null;

    return { ...result, hasModeratorOverride };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const deleteArticleById = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId: number; isModerator?: boolean }) => {
  try {
    const article = await dbWrite.article.findUnique({
      where: { id },
      select: { userId: true },
    });
    if (!article) throw throwNotFoundError(`No article with id ${id}`);

    const isOwner = article.userId === userId || isModerator;
    if (!isOwner) throw throwAuthorizationError(`You cannot perform this action`);

    // Collect content image IDs BEFORE the transaction deletes connections
    const contentImageConnections = await dbWrite.imageConnection.findMany({
      where: { entityId: id, entityType: ImageConnectionType.Article },
      select: { imageId: true },
    });

    const deleted = await dbWrite.$transaction(async (tx) => {
      const article = await tx.article.delete({
        where: { id },
        select: { coverId: true },
      });

      await tx.file.deleteMany({ where: { entityId: id, entityType: 'Article' } });
      await tx.imageConnection.deleteMany({
        where: { entityId: id, entityType: ImageConnectionType.Article },
      });

      return article;
    });

    // Delete cover image (DB + S3 + cache)
    if (deleted.coverId) await deleteImageById({ id: deleted.coverId });

    // Delete content images (DB + S3 + cache), excluding cover (already handled above)
    // Only delete images that have no remaining connections to ANY entity
    const contentImageIds = contentImageConnections
      .map((conn) => conn.imageId)
      .filter((imageId) => imageId !== deleted.coverId);

    if (contentImageIds.length > 0) {
      const trulyOrphanedImages = await dbWrite.image.findMany({
        where: { id: { in: contentImageIds }, connections: { none: {} } },
        select: { id: true },
      });

      for (const { id: imageId } of trulyOrphanedImages) {
        await deleteImageById({ id: imageId }).catch((error) => {
          handleLogError(error, 'article-content-image-cleanup', {
            articleId: id,
            imageId,
          });
        });
      }
    }

    await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

    return deleted;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getDraftArticlesByUserId = async ({
  userId,
  page,
  limit,
}: GetAllSchema & { userId: number }) => {
  try {
    const { take, skip } = getPagination(limit, page);
    const where: Prisma.ArticleFindManyArgs['where'] = {
      userId,
      status: { in: [ArticleStatus.Draft, ArticleStatus.Unpublished] },
    };

    const db = await getDbWithoutLag('userArticles', userId);
    const articles = await db.article.findMany({
      take,
      skip,
      where,
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        status: true,
        tags: {
          where: { tag: { isCategory: true } },
          select: { tag: { select: { id: true, name: true } } },
        },
      },
    });
    const count = await db.article.count({ where });

    const items = articles.map(({ tags, ...article }) => ({
      ...article,
      category: tags[0]?.tag,
    }));

    return getPagingData({ items, count }, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};

export async function unpublishArticleById({
  id,
  reason,
  customMessage,
  metadata,
  userId,
  isModerator,
}: {
  id: number;
  reason?: string;
  customMessage?: string;
  metadata?: ArticleMetadata;
  userId: number;
  isModerator?: boolean;
}) {
  // Fetch article
  const db = await getDbWithoutLag('article', id);
  const article = await db.article.findUnique({
    where: { id },
    select: { userId: true, publishedAt: true, status: true },
  });

  if (!article) throw throwNotFoundError(`No article with id ${id}`);

  // Permission check (defensive, already checked in middleware)
  const isOwner = article.userId === userId || isModerator;
  if (!isOwner) throw throwAuthorizationError('You cannot perform this action');

  // State validation
  if (!article.publishedAt || article.status !== ArticleStatus.Published) {
    throw throwBadRequestError('Article is not published');
  }

  // Atomic update with transaction
  const updated = await dbWrite.$transaction(
    async (tx) => {
      const unpublishedAt = new Date().toISOString();

      // Build updated metadata
      const updatedMetadata = {
        ...metadata,
        ...(reason
          ? {
              unpublishedReason: reason,
              customMessage,
            }
          : {}),
        unpublishedAt,
        unpublishedBy: userId,
      };

      // Update article status and metadata
      return await tx.article.update({
        where: { id },
        data: {
          status: reason ? ArticleStatus.UnpublishedViolation : ArticleStatus.Unpublished,
          metadata: updatedMetadata,
        },
      });
    },
    { timeout: 30000, maxWait: 10000 }
  );

  // Update search index (remove from public search)
  await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);

  // Bust user content cache
  await userArticleCountCache.refresh(article.userId);
  await preventReplicationLag('article', id);
  await preventReplicationLag('userArticles', article.userId);

  return updated;
}

export async function restoreArticleById({ id, userId }: { id: number; userId: number }) {
  const db = await getDbWithoutLag('article', id);
  const article = await db.article.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      metadata: true,
      publishedAt: true,
    },
  });

  if (!article) throw throwNotFoundError(`No article with id ${id}`);

  // Can only restore unpublished articles
  if (
    ![ArticleStatus.Unpublished, ArticleStatus.UnpublishedViolation].some(
      (s) => s === article.status
    )
  ) {
    throw throwBadRequestError('Article is not unpublished');
  }

  const updated = await dbWrite.$transaction(
    async (tx) => {
      const metadata = (article.metadata as ArticleMetadata) || {};

      // Clear unpublish metadata
      const updatedMetadata = {
        ...metadata,
        unpublishedReason: undefined,
        customMessage: undefined,
        unpublishedAt: undefined,
        unpublishedBy: undefined,
      };

      return await tx.article.update({
        where: { id },
        data: {
          status: ArticleStatus.Published,
          // Preserve the original publishedAt so mod-restoring an
          // Unpublished/UnpublishedViolation article doesn't surface it at
          // the top of the Newest feed (which sorts by publishedAt). Fresh
          // `new Date()` is the fallback only for the edge case of restoring
          // a row that was never publishedAt-stamped — same anti-bump shape
          // used by recomputeArticleIngestion's flipPublishedAt.
          publishedAt: article.publishedAt ?? new Date(),
          metadata: updatedMetadata,
        },
      });
    },
    { timeout: 30000, maxWait: 10000 }
  );

  // Re-derive ingestion state AND nsfwLevel (also queues the search index
  // update internally). Handles the case where the article was sitting at
  // Pending before being unpublished and now needs to be re-evaluated against
  // current image/text state. Using `updateArticleImageScanStatus` rather
  // than bare `recomputeArticleIngestion` guarantees `Article.nsfwLevel` is
  // re-derived from the current cover/content image ratings — otherwise a
  // cover that was raised to R/X/XXX while the article sat unpublished would
  // leak into the SFW feed the moment we flip status back to Published.
  await updateArticleImageScanStatus([id]).catch((e) =>
    handleLogError(e, 'article-restore-recompute', { articleId: id })
  );

  await userArticleCountCache.refresh(article.userId);
  await preventReplicationLag('article', id);
  await preventReplicationLag('userArticles', article.userId);

  return updated;
}

export async function getModeratorArticles({
  limit,
  cursor,
  username,
  status,
}: GetModeratorArticlesSchema & { limit: number }) {
  const AND: Prisma.ArticleWhereInput[] = [
    {
      status: {
        in: status ? [status] : [ArticleStatus.Unpublished, ArticleStatus.UnpublishedViolation],
      },
    },
  ];

  if (username) {
    AND.push({
      user: {
        username: { contains: username, mode: 'insensitive' },
      },
    });
  }

  const items = await dbRead.article.findMany({
    take: limit + 1,
    cursor: cursor ? { id: cursor } : undefined,
    where: { AND },
    // Mod-only list — safe to surface the moderator override value alongside
    // the regular detail fields. See note on `articleDetailSelect`.
    select: { ...articleDetailSelect, moderatorNsfwLevel: true },
    orderBy: { createdAt: 'desc' },
  });

  let nextCursor: number | undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  return {
    nextCursor,
    items: items.map((article) => ({
      ...article,
      metadata: article.metadata as ArticleMetadata | null,
    })),
  };
}

// --- Article Image Scanning Functions ---

/**
 * Link article content images to article entity
 * Creates Image entities and ImageConnections for all embedded images
 *
 * Uses batch queries to prevent N+1 performance issues
 *
 * @param articleId - Article ID to link images to
 * @param content - Article HTML content
 * @param userId - User ID for image ownership
 */
export async function linkArticleContentImages({
  articleId,
  content,
  userId,
  coverId,
  cleanupOnly,
}: {
  articleId: number;
  content: string;
  userId: number;
  coverId?: number | null;
  cleanupOnly?: boolean;
}): Promise<{ orphanedImageIds: number[] }> {
  const contentImages = getContentMedia(content);

  const { orphanedImageIds, imagesToIngest } = await dbWrite.$transaction(async (tx) => {
    const imageUrls = contentImages.map((img) => img.url);

    // Track content image IDs for orphan detection
    let contentImageIds: number[] = [];
    let imagesToIngest: { id: number; url: string; ingestion?: ImageIngestionStatus }[] = [];

    if (!cleanupOnly) {
      // Batch query: Get all existing images in one query
      const existingImages = await tx.image.findMany({
        where: { url: { in: imageUrls } },
        select: { id: true, url: true, ingestion: true },
      });

      const existingUrlMap = new Map(existingImages.map((img) => [img.url, img]));

      // Batch create: Missing images (upsert with unique constraint handles races)
      const missingMedia = contentImages.filter((media) => !existingUrlMap.has(media.url));
      const newlyCreatedImages: { id: number; url: string }[] = [];

      if (missingMedia.length > 0) {
        const newImages = await tx.image.createManyAndReturn({
          data: missingMedia.map((media) => ({
            url: media.url,
            userId,
            type: media.type,
            name: media.alt,
            ingestion: ImageIngestionStatus.Pending,
            scanRequestedAt: new Date(),
          })),
          select: { id: true, url: true },
          skipDuplicates: true,
        });

        newImages.forEach((img) => {
          existingUrlMap.set(img.url, { ...img, ingestion: ImageIngestionStatus.Pending });
          newlyCreatedImages.push(img);
        });
      }

      // Batch upsert: ImageConnections
      for (const url of imageUrls) {
        const image = existingUrlMap.get(url);
        if (!image) continue;

        await tx.imageConnection.upsert({
          where: {
            imageId_entityType_entityId: {
              imageId: image.id,
              entityType: ImageConnectionType.Article,
              entityId: articleId,
            },
          },
          create: {
            imageId: image.id,
            entityType: ImageConnectionType.Article,
            entityId: articleId,
          },
          update: {},
        });
      }

      contentImageIds = Array.from(existingUrlMap.values()).map((img) => img.id);

      // Queue images for ingestion
      const pendingExistingImages = existingImages.filter(
        (img) => img.ingestion === ImageIngestionStatus.Pending
      );
      imagesToIngest = [...newlyCreatedImages, ...pendingExistingImages];
    } else {
      // In cleanupOnly mode, we still need to know which images are in the current content
      // so we can detect orphans. Query by URL to get their IDs.
      const existingImages = await tx.image.findMany({
        where: { url: { in: imageUrls } },
        select: { id: true },
      });
      contentImageIds = existingImages.map((img) => img.id);
    }

    // --- Orphan detection (always runs) ---

    // Build exclusion list: content images + cover image
    const excludeImageIds = [...contentImageIds];
    if (coverId) excludeImageIds.push(coverId);

    // Get orphaned connections for this article
    const orphanedConnections = await tx.imageConnection.findMany({
      where: {
        entityType: ImageConnectionType.Article,
        entityId: articleId,
        imageId: { notIn: excludeImageIds },
      },
      select: { imageId: true },
    });

    const orphanedIds = orphanedConnections.map((conn) => conn.imageId);

    // Delete the orphaned connections
    if (orphanedIds.length > 0) {
      await tx.imageConnection.deleteMany({
        where: {
          entityType: ImageConnectionType.Article,
          entityId: articleId,
          imageId: { in: orphanedIds },
        },
      });
    }

    // Find truly orphaned images (no connections to ANY entity)
    let trulyOrphanedIds: number[] = [];
    if (orphanedIds.length > 0) {
      const trulyOrphaned = await tx.image.findMany({
        where: {
          id: { in: orphanedIds },
          connections: { none: {} },
        },
        select: { id: true },
      });
      trulyOrphanedIds = trulyOrphaned.map((img) => img.id);
    }

    return { orphanedImageIds: trulyOrphanedIds, imagesToIngest };
  });

  if (imagesToIngest.length > 0) {
    // TODO.articleImageScan: remove the lowPriority flag
    enqueueImageIngestion({
      images: imagesToIngest,
      name: 'article-image-ingest',
      userId,
      lowPriority: true,
    });
  }

  return { orphanedImageIds };
}

/**
 * Get article image scan status for real-time progress tracking
 *
 * @param articleId - Article ID to get scan status for
 * @returns Object with scan progress counts, completion status, and detailed image lists
 */
export type ArticleTextModerationStatus = {
  // True when the article has text to moderate (title or HTML-stripped content).
  // When false, the text pipeline is a no-op and textDone is implicitly true.
  required: boolean;
  // null when no EntityModeration row exists yet (either not required or
  // the submit call is still in flight and hasn't written a Pending row).
  status: EntityModerationStatus | null;
  blocked: boolean | null;
  retryCount: number;
  updatedAt: Date | null;
};

export async function getArticleScanStatus({ id }: GetByIdInput): Promise<{
  total: number;
  scanned: number;
  blocked: number;
  error: number;
  pending: number;
  allComplete: boolean;
  images: {
    blocked: Array<{
      id: number;
      url: string;
      ingestion: ImageIngestionStatus;
      blockedFor: string | null;
    }>;
    error: Array<{ id: number; url: string; ingestion: ImageIngestionStatus }>;
    pending: Array<{ id: number; url: string; ingestion: ImageIngestionStatus }>;
  };
  textModeration: ArticleTextModerationStatus;
}> {
  const [connections, article, moderation] = await Promise.all([
    dbRead.imageConnection.findMany({
      where: {
        entityId: id,
        entityType: ImageConnectionType.Article,
      },
      include: { image: { select: { id: true, url: true, ingestion: true, blockedFor: true } } },
    }),
    dbRead.article.findUnique({
      where: { id },
      select: { title: true, content: true },
    }),
    dbRead.entityModeration.findUnique({
      where: { entityType_entityId: { entityType: 'Article', entityId: id } },
      select: { status: true, blocked: true, retryCount: true, updatedAt: true },
    }),
  ]);

  const total = connections.length;
  const scannedImages = connections.filter(
    (c) => c.image.ingestion === ImageIngestionStatus.Scanned
  );
  const blockedImages = connections.filter(
    (c) => c.image.ingestion === ImageIngestionStatus.Blocked
  );
  const errorImages = connections.filter(
    (c) =>
      c.image.ingestion === ImageIngestionStatus.Error ||
      c.image.ingestion === ImageIngestionStatus.NotFound
  );
  const pendingImages = connections.filter(
    (c) => c.image.ingestion === ImageIngestionStatus.Pending
  );

  const required = article ? articleHasText(article.title, article.content) : false;
  const textTerminalStatuses = new Set<EntityModerationStatus>([
    EntityModerationStatus.Succeeded,
    EntityModerationStatus.Failed,
    EntityModerationStatus.Expired,
    EntityModerationStatus.Canceled,
  ]);
  const textDone = !required || (!!moderation && textTerminalStatuses.has(moderation.status));

  return {
    total,
    scanned: scannedImages.length,
    blocked: blockedImages.length,
    error: errorImages.length,
    pending: pendingImages.length,
    allComplete: pendingImages.length === 0 && textDone,
    images: {
      blocked: blockedImages.map((c) => c.image),
      error: errorImages.map((c) => c.image),
      pending: pendingImages.map((c) => c.image),
    },
    textModeration: {
      required,
      status: moderation?.status ?? null,
      blocked: moderation?.blocked ?? null,
      retryCount: moderation?.retryCount ?? 0,
      updatedAt: moderation?.updatedAt ?? null,
    },
  };
}

/**
 * Update article scan status after images complete scanning.
 *
 * Recomputes the article's nsfwLevel once all images reach a terminal state,
 * then delegates all status/ingestion transitions (Processing→Published,
 * Pending/Rescan→Scanned/Blocked/Error) and author notifications to
 * `recomputeArticleIngestion`, which is the single source of truth for
 * article scan state.
 */
export async function updateArticleImageScanStatus(articleIds: number[]): Promise<void> {
  for (const articleId of articleIds) {
    // One atomic transaction: advisory lock → NSFW level update → ingestion
    // recompute. Closes the drift window where a crash between the NSFW
    // update and the recompute would leave the Article row with updated
    // nsfwLevel but stale ingestion.
    //
    // NSFW recompute runs unconditionally: the SQL in `updateArticleNsfwLevels`
    // already filters to Scanned/Blocked cover + Scanned content, so it is
    // safe on partial state. Gating this on "all content images terminal"
    // historically let R/X/XXX covers leak into the SFW feed whenever any
    // content image was still Pending — the cover had already resolved but
    // the article's nsfwLevel stayed pinned to userNsfwLevel until the last
    // content image finished.
    const result = await dbWrite.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${articleId})`;

        await updateArticleNsfwLevels([articleId], tx);

        return recomputeArticleIngestionInTx(tx, articleId);
      },
      { timeout: 30000, maxWait: 10000 }
    );

    await dispatchArticleIngestionPostCommit(result);
  }
}

/**
 * Does this article have any text worth sending to the text-moderation pipeline?
 * Shared between the submit-text-moderation gate and the recomputeArticleIngestion
 * empty-content branch so the two can't drift: anything that wouldn't be submitted
 * must also be treated as "textDone" by the state machine, otherwise the article
 * gets trapped in Pending waiting for a moderation callback that will never come.
 */
export function articleHasText(title: string | null, content: string | null): boolean {
  const titleText = title?.trim() ?? '';
  const contentText = removeTags(content ?? '').trim();
  return titleText.length > 0 || contentText.length > 0;
}

/**
 * Recompute Article.ingestion from ground truth (Image.ingestion + EntityModeration)
 * and drive associated status transitions.
 *
 * Single source of truth for article scan state. Call it after:
 * - Image scan webhooks (via updateArticleImageScanStatus)
 * - Text moderation webhooks (success or failure)
 * - Article upsert (to lock in Pending state)
 * - Backfill / reconcile per article
 *
 * Transitions handled:
 * - ingestion -> Scanned: sets contentScannedAt; if status == Processing, flips
 *   status to Published and sends the "article published" notification.
 * - ingestion -> Blocked/Error (all images terminal) while status == Processing:
 *   sends the "images blocked/failed" notification so the author can fix and
 *   resubmit. Status is left at Processing so the author can edit.
 */
export type RecomputeIngestionResult = {
  articleId: number;
  publishedNotificationUserId: number | null;
  problemsNotification: { userId: number; blockedImages: number; errorImages: number } | null;
};

/**
 * In-transaction half of the ingestion state machine. Takes the advisory lock,
 * reads ground truth (image connections + EntityModeration + article fields),
 * derives the next ingestion state, and writes the Article row. Returns hints
 * for post-commit dispatch (search index queue + notifications) — those MUST be
 * run after commit via `dispatchArticleIngestionPostCommit`, otherwise Redis
 * queue / notification failures would roll back the state write.
 *
 * Exposed as a primitive so callers that need to combine ingestion recompute
 * with other writes (text-moderation webhook, updateArticleImageScanStatus) can
 * run everything under a single advisory-locked transaction. The advisory lock
 * is re-entrant within the same session, so taking it again here if the caller
 * already did is safe.
 */
export async function recomputeArticleIngestionInTx(
  tx: Prisma.TransactionClient,
  articleId: number
): Promise<RecomputeIngestionResult> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${articleId})`;

  // --- Image side (content images + cover) ---
  //
  // Cover lives on `Article.coverId` and is *not* duplicated into
  // `ImageConnection`, so we have to read it separately and fold it into the
  // terminal-state counts. Without this, an article with zero content images
  // and a still-Pending cover would compute `imageDone=true` and flip to
  // `ingestion=Scanned`, publishing the article while its cover rating is
  // still unknown. A cover whose scan later resolves to R/X/XXX (or Blocked)
  // would then need the webhook-driven forward path to propagate — and any
  // missed or disabled webhook becomes a silent leak.
  //
  // Counting the cover here means:
  //   - cover still Pending → imageDone=false → ingestion=Pending → search
  //     index drops the article until the cover resolves.
  //   - cover Scanned/Blocked → contributes to imageDone; Blocked also
  //     escalates to `imageBlocked` so the article transitions to
  //     ingestion=Blocked (hidden from feed) instead of silently leaking.
  //   - cover changed on edit (new Pending image) → ingestion falls back to
  //     Pending automatically on the next recompute, no special-case save
  //     logic required.
  const connections = await tx.imageConnection.findMany({
    where: { entityId: articleId, entityType: ImageConnectionType.Article },
    include: { image: { select: { ingestion: true } } },
  });

  const current = await tx.article.findUniqueOrThrow({
    where: { id: articleId },
    select: {
      ingestion: true,
      status: true,
      publishedAt: true,
      userId: true,
      title: true,
      content: true,
      coverId: true,
      moderatorNsfwLevel: true,
    },
  });

  const coverIngestion = current.coverId
    ? (
        await tx.image.findUnique({
          where: { id: current.coverId },
          select: { ingestion: true },
        })
      )?.ingestion ?? null
    : null;

  const imageStates: ImageIngestionStatus[] = [
    ...connections.map((c) => c.image.ingestion),
    ...(coverIngestion ? [coverIngestion] : []),
  ];

  const totalImages = imageStates.length;
  const scannedImages = imageStates.filter((s) => s === ImageIngestionStatus.Scanned).length;
  const blockedImages = imageStates.filter((s) => s === ImageIngestionStatus.Blocked).length;
  const errorImages = imageStates.filter(
    (s) => s === ImageIngestionStatus.Error || s === ImageIngestionStatus.NotFound
  ).length;

  const imageBlocked = blockedImages > 0;
  const imageError = errorImages > 0;
  const imageDone =
    totalImages === 0 || scannedImages + blockedImages + errorImages === totalImages;

  // --- Text moderation side ---
  const textModeration = await tx.entityModeration.findUnique({
    where: { entityType_entityId: { entityType: 'Article', entityId: articleId } },
    select: { status: true, blocked: true },
  });

  // Articles with no text to scan (empty/null title AND content) can never
  // receive a moderation callback, so we must treat them as textDone here.
  // Also guards blocked/error on any stale EntityModeration row whose
  // content has since been emptied.
  const hasText = articleHasText(current.title, current.content);
  const textErrorStatuses: string[] = [
    EntityModerationStatus.Failed,
    EntityModerationStatus.Expired,
    EntityModerationStatus.Canceled,
  ];
  const textBlocked =
    hasText &&
    textModeration?.status === EntityModerationStatus.Succeeded &&
    textModeration.blocked === true;
  const textError =
    hasText && !!textModeration && textErrorStatuses.includes(textModeration.status);
  const textDone = !hasText || textModeration?.status === EntityModerationStatus.Succeeded;

  // --- Derive ingestion state (precedence documented on deriveArticleIngestionState) ---
  const hasModeratorOverride = current.moderatorNsfwLevel != null;

  const next = deriveArticleIngestionState({
    imageBlocked,
    imageError,
    imageDone,
    textBlocked,
    textError,
    textDone,
    hasModeratorOverride,
  });

  const flipToPublished =
    next === ArticleIngestionStatus.Scanned && current.status === ArticleStatus.Processing;

  const setScannedAt =
    next === ArticleIngestionStatus.Scanned && current.ingestion !== ArticleIngestionStatus.Scanned;
  const flipPublishedAt = flipToPublished ? current.publishedAt ?? new Date() : null;

  // Raw SQL because Prisma's @updatedAt on Article.updatedAt fires on every
  // client-side update(), which would bump "Recently Updated" feed position
  // every time a scan webhook or the reconcile cron touches the row. Writing
  // only the scan-state columns via $executeRaw bypasses that.
  const setFragments: Prisma.Sql[] = [Prisma.sql`ingestion = ${next}::"ArticleIngestionStatus"`];
  if (setScannedAt) {
    setFragments.push(Prisma.sql`"contentScannedAt" = ${new Date()}`);
  }
  if (flipToPublished) {
    setFragments.push(Prisma.sql`status = ${ArticleStatus.Published}::"ArticleStatus"`);
    setFragments.push(Prisma.sql`"publishedAt" = ${flipPublishedAt}`);
  }
  await tx.$executeRaw`
    UPDATE "Article"
    SET ${Prisma.join(setFragments, ', ')}
    WHERE id = ${articleId}
  `;

  // Populate post-commit hints. Notifications dedupe via `key`
  // (article-published-$id / article-images-blocked-$id) so re-notifying on
  // repeated terminal-state recomputes is safe.
  let publishedNotificationUserId: number | null = null;
  let problemsNotification: { userId: number; blockedImages: number; errorImages: number } | null =
    null;

  if (flipToPublished) {
    publishedNotificationUserId = current.userId;
  } else if (
    current.status === ArticleStatus.Processing &&
    imageDone &&
    (next === ArticleIngestionStatus.Blocked || next === ArticleIngestionStatus.Error) &&
    (blockedImages > 0 || errorImages > 0)
  ) {
    // Fire once all images are terminal and at least one is problematic.
    // No ingestion-transition guard: if an early image blocks, ingestion
    // moves to Blocked before the remaining Pending images finish; by the
    // time they do, ingestion is unchanged and a transition check would
    // miss the notification.
    problemsNotification = {
      userId: current.userId,
      blockedImages,
      errorImages,
    };
  }

  return { articleId, publishedNotificationUserId, problemsNotification };
}

/**
 * Post-commit side effects for `recomputeArticleIngestionInTx`. Must run after
 * the transaction commits so that:
 *   - the search-index indexer reads committed state when it dequeues the id,
 *   - notification failures don't roll back the ingestion state write.
 *
 * Search index queue and notifications dedupe on their own, so calling this
 * twice for the same result is safe.
 */
export async function dispatchArticleIngestionPostCommit(
  result: RecomputeIngestionResult
): Promise<void> {
  const { articleId, publishedNotificationUserId, problemsNotification } = result;

  // Sync search index — the index filters on ingestion = 'Scanned', so any
  // ingestion state change must be reflected (add when Scanned, remove otherwise).
  await articlesSearchIndex.queueUpdate([
    { id: articleId, action: SearchIndexUpdateQueueAction.Update },
  ]);

  if (publishedNotificationUserId !== null) {
    await createNotification({
      userId: publishedNotificationUserId,
      category: NotificationCategory.System,
      type: 'system-message',
      key: `article-published-${articleId}`,
      details: {
        message: `Your article has been published successfully!`,
        url: `/articles/${articleId}`,
      },
    }).catch((e) => handleLogError(e, 'article-ingestion-published-notification', { articleId }));
  }

  if (problemsNotification) {
    const { userId, blockedImages, errorImages } = problemsNotification;
    await createNotification({
      userId,
      category: NotificationCategory.System,
      type: 'system-message',
      key: `article-images-blocked-${articleId}`,
      details: {
        message: `Your article cannot be published: ${
          blockedImages > 0
            ? `${blockedImages} image(s) blocked (policy violation)`
            : `${errorImages} image(s) failed to scan`
        }. Please remove or replace these images and resubmit.`,
        url: `/articles/${articleId}/edit`,
      },
    }).catch((e) => handleLogError(e, 'article-ingestion-problems-notification', { articleId }));
  }

  // Owner re-disputed during a Rescan (gate blocked on `ingestion != Scanned`)
  // and the scan has now settled — re-evaluate the auto-approve gate. The
  // helper is fully self-contained and never throws.
  await maybeAutoResolveDisputeAfterScan(articleId);
}

export async function recomputeArticleIngestion(articleId: number): Promise<void> {
  const result = await dbWrite.$transaction(
    async (tx) => recomputeArticleIngestionInTx(tx, articleId),
    {
      timeout: 30000,
      maxWait: 10000,
    }
  );
  await dispatchArticleIngestionPostCommit(result);
}

const RESCAN_LIMIT = 3;
const RESCAN_WINDOW_SECONDS = CacheTTL.day; // 24 hours

/**
 * Rescan an article: re-queue all content images and re-submit text moderation.
 *
 * Resets ingestion to Rescan, clears contentScannedAt, and lets the normal
 * webhook flow (image scan + text moderation) drive the article back to a
 * terminal ingestion state via recomputeArticleIngestion.
 */
export async function rescanArticle({
  id,
  isModerator,
}: GetByIdInput & { isModerator?: boolean }): Promise<void> {
  // --- Rate limit (owners only, mods bypass) ---
  const cacheKey = `${REDIS_KEYS.ARTICLE.RESCAN}:${id}` as const;
  if (!isModerator) {
    const attempts = (await redis.packed.get<number[]>(cacheKey)) ?? [];
    const cutoff = Date.now() - RESCAN_WINDOW_SECONDS * 1000;
    const recentAttempts = attempts.filter((t) => t > cutoff);

    if (recentAttempts.length >= RESCAN_LIMIT) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `This article can only be rescanned ${RESCAN_LIMIT} times per day. Please try again later.`,
      });
    }
  }

  // --- Fetch article ---
  const db = await getDbWithoutLag('article', id);
  const article = await db.article.findUnique({
    where: { id },
    select: { id: true, userId: true, content: true, title: true, coverId: true },
  });
  if (!article) throw throwNotFoundError(`No article with id ${id}`);

  // --- Reset ingestion state ---
  // Raw SQL to avoid bumping Article.updatedAt — a rescan is not a user-edit
  // and shouldn't reorder the "Recently Updated" feed.
  await dbWrite.$executeRaw`
    UPDATE "Article"
    SET ingestion = ${ArticleIngestionStatus.Rescan}::"ArticleIngestionStatus",
        "scanRequestedAt" = ${new Date()},
        "contentScannedAt" = NULL
    WHERE id = ${id}
  `;
  await preventReplicationLag('article', id);
  await preventReplicationLag('userArticles', article.userId);

  // Remove from search index immediately — article should not be searchable while rescanning.
  await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

  // --- Re-link content images (picks up new images, queues Pending ones) ---
  if (article.content) {
    await linkArticleContentImages({
      articleId: id,
      content: article.content,
      userId: article.userId,
      coverId: article.coverId,
    });
  }

  // --- Re-queue already-processed images for rescan ---
  const connections = await dbRead.imageConnection.findMany({
    where: { entityId: id, entityType: ImageConnectionType.Article },
    include: { image: { select: { id: true, url: true, ingestion: true, type: true } } },
  });

  const imagesToIngest = connections
    .filter((conn) => conn.image.ingestion !== ImageIngestionStatus.Pending)
    .map((conn) => conn.image);

  enqueueImageIngestion({
    images: imagesToIngest,
    name: 'article-rescan-image',
    userId: article.userId,
    lowPriority: true,
  });

  // --- Force a fresh text moderation scan ---
  // `forceRescan: true` bypasses the contentHash dedup in
  // `createXGuardModerationRequest` so a moderator-initiated rescan
  // produces a new orchestrator workflow even when the article's text
  // is unchanged.
  if (article.content) {
    const textForModeration = [article.title, removeTags(article.content)]
      .filter(Boolean)
      .join(' ');

    await submitTextModeration({
      entityType: 'Article',
      entityId: id,
      content: textForModeration,
      labels: ['nsfw'],
      recordForReview: true,
      forceRescan: true,
    }).catch((e) => {
      logToAxiom({
        type: 'error',
        name: 'article-rescan-text-moderation',
        message: (e as Error).message,
        articleId: id,
      }).catch();
    });
  }

  // --- Record rate limit attempt ---
  const attempts = (await redis.packed.get<number[]>(cacheKey)) ?? [];
  attempts.push(Date.now());
  const cutoff = Date.now() - RESCAN_WINDOW_SECONDS * 1000;
  await redis.packed.set(
    cacheKey,
    attempts.filter((t) => t > cutoff)
  );
  await redis.expire(cacheKey, RESCAN_WINDOW_SECONDS);

  // --- Lock ingestion state ---
  // Covers articles with no content and no images, where no webhook will fire
  // to advance state back to Scanned.
  await recomputeArticleIngestion(id).catch((e) =>
    handleLogError(e, 'article-rescan-recompute', { articleId: id })
  );

  // --- Log for observability ---
  logToAxiom({
    type: 'info',
    name: 'article-rescan',
    articleId: id,
    imageCount: connections.length,
    isModerator,
  }).catch();
}

// =============================================================================
// Article NSFW level dispute / review
// =============================================================================

const NSFW_REVIEW_LIMIT = 3;
const NSFW_REVIEW_WINDOW_SECONDS = CacheTTL.day; // 24 hours

const VALID_NSFW_LEVELS = new Set<number>(browsingLevels);

/**
 * Owner-driven request to re-rate an article. Performs service-layer auth
 * (no router middleware) per project convention.
 *
 * Invariants:
 * - Only the article owner can file a dispute.
 * - `suggestedLevel` must be a single-bit constant from the canonical
 *   set (PG / PG13 / R / X / XXX).
 * - At most one Pending review per article at any time.
 * - Owners are gated by a rate limit (3 / 24h, mods bypass).
 * - If a prior review has resolved, the owner can re-file only if the
 *   article was edited after that resolution (`updatedAt > resolvedAt`).
 */
export async function createArticleRatingReview({
  articleId,
  userId,
  suggestedLevel,
  userComment,
  isModerator,
}: CreateArticleRatingReviewInput & {
  userId: number;
  isModerator?: boolean;
}) {
  // --- Validate the suggested level against the canonical bitwise set ---
  if (!VALID_NSFW_LEVELS.has(suggestedLevel)) {
    throw throwBadRequestError(
      `Invalid suggested NSFW level. Must be one of: ${[...VALID_NSFW_LEVELS].join(', ')}`
    );
  }

  // --- Load article and assert ownership at the service layer ---
  // Fetch the article + existing-pending + last-resolved reads in parallel —
  // they're independent and the round-trips dominate latency here.
  const [article, existingPending, lastResolved] = await Promise.all([
    dbRead.article.findUnique({
      where: { id: articleId },
      select: {
        id: true,
        userId: true,
        nsfwLevel: true,
        updatedAt: true,
        // Extra fields powering the auto-approve gate (status / ingestion /
        // override / coverId) — cheap to fetch alongside the ownership check
        // so we don't issue a second round-trip on the eligible path.
        status: true,
        ingestion: true,
        moderatorNsfwLevel: true,
        moderatorNsfwLevelBasis: true,
        coverId: true,
        title: true,
      },
    }),
    dbRead.articleRatingReview.findFirst({
      where: { articleId, status: ReportStatus.Pending },
      select: { id: true },
    }),
    dbRead.articleRatingReview.findFirst({
      where: {
        articleId,
        status: { in: [ReportStatus.Actioned, ReportStatus.Unactioned] },
        resolvedAt: { not: null },
      },
      orderBy: { resolvedAt: 'desc' },
      select: { id: true, resolvedAt: true },
    }),
  ]);

  if (!article) throw throwNotFoundError(`No article with id ${articleId}`);
  if (article.userId !== userId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the article owner can submit a rating review',
    });
  }

  // --- No-op guard ---
  // A review that suggests the rating the article already carries can never
  // change anything, so reject it up front (before the rate-limit gate burns
  // a slot). The modal also disables the current level, but a stale client or
  // the mod API could still send it.
  if (suggestedLevel === article.nsfwLevel) {
    throw throwBadRequestError(
      'The suggested rating matches the article’s current rating. Choose a different level.'
    );
  }

  // --- One Pending per article ---
  if (existingPending) {
    throw throwBadRequestError('A review is already pending for this article');
  }

  // --- Re-edit gate: if any prior resolved review exists, require the
  //     article to have been edited since the most recent resolution ---
  if (
    lastResolved?.resolvedAt &&
    (!article.updatedAt || article.updatedAt <= lastResolved.resolvedAt)
  ) {
    throw throwBadRequestError(
      'This article has already been reviewed. Edit the article before requesting another review.'
    );
  }

  // --- Rate limit (owners only, mods bypass) ---
  // Run AFTER the "one Pending per article" and re-edit gates so a request
  // that's guaranteed to be rejected by either of those doesn't burn a slot.
  // Atomic INCR + EXPIRE-on-first to avoid the TOCTOU race in the prior
  // get → check → set → expire dance. Concurrent duplicate Pending inserts
  // are still prevented by the partial unique index on `ArticleRatingReview`.
  // `incr` isn't surfaced on the typed redis client, hence the cast.
  const cacheKey = `${REDIS_KEYS.ARTICLE.RATING_REVIEW_RATE_LIMIT}:${userId}` as const;
  if (!isModerator) {
    const count = await (redis as any).incr(cacheKey);
    if (count === 1) await redis.expire(cacheKey, NSFW_REVIEW_WINDOW_SECONDS);
    if (count > NSFW_REVIEW_LIMIT) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `You can only submit ${NSFW_REVIEW_LIMIT} rating reviews per day. Please try again later.`,
      });
    }
  }

  // --- Auto-approve branch ---
  // If the dispute is a down-direction request and the article's rescan
  // already agrees with the requested level, skip the mod queue entirely:
  // insert the review directly as Actioned, clear the mod override, and let
  // the recompute land the effective level at `suggestedLevel`. Moderators
  // bypass this path — they go through `resolveArticleRatingReview` instead,
  // so a mod hitting the dispute endpoint as themselves still creates a
  // normal Pending row for review.
  if (!isModerator) {
    const gate = await evaluateAutoApproveGate({
      article: {
        id: article.id,
        status: article.status,
        ingestion: article.ingestion,
        nsfwLevel: article.nsfwLevel,
        moderatorNsfwLevel: article.moderatorNsfwLevel,
        moderatorNsfwLevelBasis: article.moderatorNsfwLevelBasis,
        coverId: article.coverId,
      },
      suggestedLevel,
    });

    if (gate.eligible) {
      // Insert as Pending FIRST so the partial unique index
      // (`ArticleRatingReview_pending_per_article`, WHERE status='Pending')
      // serializes concurrent submissions for the same article — the loser of
      // the race hits P2002 and is rejected here rather than producing a
      // duplicate Actioned row + duplicate "approved" notification. We then
      // promote the row via the race-safe resolve-existing path.
      let pendingId: number;
      try {
        const created = await dbWrite.articleRatingReview.create({
          data: {
            articleId,
            userId,
            currentLevel: article.nsfwLevel,
            suggestedLevel,
            userComment,
            status: ReportStatus.Pending,
          },
          select: { id: true },
        });
        pendingId = created.id;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw throwBadRequestError('A review is already pending for this article');
        }
        throw e;
      }

      try {
        const auto = await autoResolveArticleRatingReview({
          mode: 'resolve-existing',
          reviewId: pendingId,
          articleId,
          ownerUserId: userId,
          suggestedLevel,
          previousLevel: article.nsfwLevel,
          articleTitle: article.title ?? 'your article',
        });

        logToAxiom({
          type: 'info',
          name: 'article-rating-review-auto-resolved',
          articleId,
          reviewId: auto.reviewId,
          suggestedLevel,
          derivedLevel: gate.derivedLevel,
          entryPoint: 'submission',
        }).catch();

        return auto.review;
      } catch (e) {
        // Another resolver (a mod, or the scan-completion retry) won the race
        // and promoted this row first. Return the row as-is; it is already
        // resolved and the article mutation stands.
        if (e instanceof AutoResolveRaceLost) {
          return dbRead.articleRatingReview.findUniqueOrThrow({ where: { id: pendingId } });
        }
        throw e;
      }
    }
  }

  // --- Snapshot the current effective level + insert ---
  const review = await dbWrite.articleRatingReview.create({
    data: {
      articleId,
      userId,
      currentLevel: article.nsfwLevel,
      suggestedLevel,
      userComment,
      status: ReportStatus.Pending,
    },
  });

  return review;
}

/**
 * Owner-only fetch of the most recent review row for this article (any
 * status) so the article detail page can render
 * "Submit review / Pending / Approved / Rejected" badges.
 */
export async function getArticleRatingReviewForOwner({
  articleId,
  userId,
}: {
  articleId: number;
  userId: number;
}) {
  const article = await dbRead.article.findUnique({
    where: { id: articleId },
    select: {
      id: true,
      userId: true,
      updatedAt: true,
      nsfwLevel: true,
      moderatorNsfwLevel: true,
      moderatorNsfwLevelBasis: true,
    },
  });
  if (!article) throw throwNotFoundError(`No article with id ${articleId}`);
  if (article.userId !== userId) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only the article owner can view this review',
    });
  }

  const review = await dbRead.articleRatingReview.findFirst({
    where: { articleId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      createdAt: true,
      resolvedAt: true,
      currentLevel: true,
      suggestedLevel: true,
      appliedLevel: true,
      userComment: true,
      modComment: true,
    },
  });

  // Stale-override signal for the owner banner: only meaningful when an
  // override is active AND content has genuinely dropped below the basis it was
  // set against — which is exactly the auto-approve gate's #6 precondition. We
  // compare derived to `moderatorNsfwLevelBasis` (not to the override itself) so
  // the banner only advertises a dispute that will actually auto-approve; an
  // override sitting above the images (basis == derived) won't light it up,
  // since disputing it would just route to the mod queue.
  // Skip the derived computation when there's no override (the auto path
  // already resolves to ground truth) or when the article has no resubmit
  // option anyway (Pending review blocks it).
  let derivedLevel: number | null = null;
  let derivedRatingDroppedBelowOverride = false;
  if (article.moderatorNsfwLevel != null && review?.status !== ReportStatus.Pending) {
    derivedLevel = await computeArticleDerivedNsfwLevel(articleId);
    derivedRatingDroppedBelowOverride =
      derivedLevel != null &&
      article.moderatorNsfwLevelBasis != null &&
      derivedLevel < article.moderatorNsfwLevelBasis;
  }

  if (!review) {
    return {
      review: null,
      canResubmit: true,
      derivedLevel,
      derivedRatingDroppedBelowOverride,
    };
  }

  // Compute canResubmit server-side so clock skew can't open or close the
  // resubmit gate from the client. Mirrors the createArticleRatingReview
  // re-edit gate: a fresh dispute is allowed only when the article has been
  // edited after the prior review resolved. Pending reviews block resubmit
  // outright.
  const canResubmit =
    review.status !== ReportStatus.Pending &&
    review.resolvedAt != null &&
    article.updatedAt != null &&
    article.updatedAt > review.resolvedAt;

  return { review, canResubmit, derivedLevel, derivedRatingDroppedBelowOverride };
}

/**
 * Moderator dashboard query. Mirrors getImageRatingRequests shape:
 * keyset cursor on `id`, returns `{ items, nextCursor }`.
 */
export async function getArticleRatingReviews({
  cursor,
  limit,
  status,
}: GetArticleRatingReviewsInput) {
  const rows = await dbRead.articleRatingReview.findMany({
    where: {
      status,
      ...(cursor ? { id: { lt: cursor } } : {}),
    },
    orderBy: { id: 'desc' },
    take: limit + 1,
    select: {
      id: true,
      createdAt: true,
      resolvedAt: true,
      status: true,
      currentLevel: true,
      suggestedLevel: true,
      appliedLevel: true,
      userComment: true,
      modComment: true,
      resolvedBy: true,
      // The moderator who actioned the review (null for auto-approved /
      // system-resolved rows) — surfaced on the card for audit.
      resolver: {
        select: {
          id: true,
          username: true,
          image: true,
        },
      },
      user: {
        select: {
          id: true,
          username: true,
          image: true,
        },
      },
      article: {
        select: {
          id: true,
          title: true,
          // Legacy URL column — null for all current articles. Kept only as a
          // fallback; the live cover is resolved from `coverId` below.
          cover: true,
          coverId: true,
          nsfwLevel: true,
          userNsfwLevel: true,
          moderatorNsfwLevel: true,
          publishedAt: true,
        },
      },
    },
  });

  let nextCursor: number | undefined;
  if (rows.length > limit) {
    const last = rows.pop();
    nextCursor = last?.id;
  }

  // Resolve cover images from `coverId` (mirrors the main article feed). The
  // legacy `Article.cover` string is null for every current article, so the
  // review cards rendered blank covers until this lookup was added.
  // Dedupe ids (resolved tabs can hold multiple reviews for the same article)
  // and index the result by id so the per-row attach below stays linear.
  const coverIds = [...new Set(rows.map((x) => x.article.coverId).filter(isDefined))];
  const coverImages = coverIds.length
    ? await dbRead.image.findMany({
        where: { id: { in: coverIds } },
        select: { id: true, url: true, type: true, nsfwLevel: true },
      })
    : [];
  const coverImageById = new Map(coverImages.map((img) => [img.id, img]));

  const items = rows.map((row) => {
    const coverImage =
      row.article.coverId != null ? coverImageById.get(row.article.coverId) ?? null : null;
    return { ...row, article: { ...row.article, coverImage } };
  });

  return { items, nextCursor };
}

export async function getArticleRatingReviewCounts() {
  const grouped = await dbRead.articleRatingReview.groupBy({
    by: ['status'],
    _count: { _all: true },
  });

  // Initialize every ReportStatus so the result is a complete
  // Record<ReportStatus, number> (empty buckets read as 0). The dashboard only
  // surfaces Pending/Actioned/Unactioned; Processing is here to satisfy the
  // type, not because it's a filterable bucket.
  const counts: Record<ReportStatus, number> = {
    [ReportStatus.Pending]: 0,
    [ReportStatus.Processing]: 0,
    [ReportStatus.Actioned]: 0,
    [ReportStatus.Unactioned]: 0,
  };
  for (const row of grouped) {
    counts[row.status] = row._count._all;
  }

  return counts;
}

/**
 * Moderator resolution. Two paths:
 * - `Actioned` → write `moderatorNsfwLevel` + `nsfwLevel` (both pinned to
 *   the applied level), lock `userNsfwLevel`, close the review row. The
 *   COALESCE in `updateArticleNsfwLevels` makes the override win uncondit-
 *   ionally, so we skip the full CTE recompute and just queue a search
 *   index update.
 * - `Unactioned` → close the review row only; no article mutation.
 *
 * Both paths run their findFirst + updateMany (status-guarded) inside the
 * same write transaction so two moderators racing on the same review can't
 * both pass the Pending check and double-fire notifications.
 *
 * Notification (approved / rejected) fires after commit. Mod activity is
 * tracked for the audit trail.
 */
export async function resolveArticleRatingReview({
  reviewId,
  moderatorId,
  appliedLevel,
  modComment,
}: ResolveArticleRatingReviewInput & {
  moderatorId: number;
}) {
  // Single-action resolution: every resolve pins the article at `appliedLevel`
  // (override). Validate the level up front before opening the transaction.
  if (!VALID_NSFW_LEVELS.has(appliedLevel)) {
    throw throwBadRequestError(
      `Invalid applied NSFW level. Must be one of: ${[...VALID_NSFW_LEVELS].join(', ')}`
    );
  }

  // Resolution returns:
  //   articleId  - for downstream notify / tracker
  //   ownerUserId - the owner who filed the review (for notify)
  //   articleTitle - pulled from the transactional update
  //   previousLevel - content-derived snapshot at submission time, for notify copy
  // The derived status (granted vs overrode-differently) is computed inside the
  // transaction from the review's `suggestedLevel` vs `appliedLevel`.
  let articleId: number;
  let ownerUserId: number;
  let articleTitle: string;
  let previousLevel: number;

  // All reads + writes go through one transaction so two mods clicking Resolve
  // simultaneously can't both pass the Pending check. The review row is updated
  // with a status guard (updateMany + count === 1) so the loser of the race
  // throws NOT_FOUND rather than double-notifying.
  //
  // `status` is no longer a caller input — the dashboard's Approved/Rejected
  // buckets now mean "was the owner's suggestion granted?". We derive it from
  // `appliedLevel === suggestedLevel`. Both branches pin the override either
  // way (see spec: 2026-06-25-article-rating-review-single-action-design.md).
  const result = await dbWrite.$transaction(async (tx) => {
    const reviewRow = await tx.articleRatingReview.findFirst({
      where: { id: reviewId, status: ReportStatus.Pending },
      select: {
        id: true,
        articleId: true,
        userId: true,
        currentLevel: true,
        suggestedLevel: true,
      },
    });
    if (!reviewRow) {
      throw throwNotFoundError('Review already resolved');
    }

    const derivedStatus =
      appliedLevel === reviewRow.suggestedLevel ? ReportStatus.Actioned : ReportStatus.Unactioned;

    const claim = await tx.articleRatingReview.updateMany({
      where: { id: reviewId, status: ReportStatus.Pending },
      data: {
        status: derivedStatus,
        resolvedAt: new Date(),
        resolvedBy: moderatorId,
        appliedLevel,
        modComment,
      },
    });
    if (claim.count !== 1) {
      throw throwNotFoundError('Review already resolved');
    }

    // Mirror the existing override-lock pattern in upsertArticle (see
    // article.service.ts:1015-1022): when an override is active, pin
    // `userNsfwLevel` so a subsequent owner save can't drift it.
    const current = await tx.article.findUnique({
      where: { id: reviewRow.articleId },
      select: { lockedProperties: true },
    });
    const lockedSet = new Set<string>(current?.lockedProperties ?? []);
    lockedSet.add('userNsfwLevel');

    // Snapshot the content-derived level at the moment this override is set,
    // so a later down-direction dispute can only auto-clear it if the content
    // genuinely drops below this basis (see evaluateAutoApproveGate gate #6).
    // A mod actioning above the images encodes judgment the scanners can't
    // reproduce; the basis is what keeps that from being auto-erased.
    const moderatorNsfwLevelBasis =
      (await computeArticleDerivedNsfwLevel(reviewRow.articleId)) ?? 0;

    // Write `moderatorNsfwLevel` (override signal), `nsfwLevel` (effective
    // level) and the basis snapshot in a single update. The CTE in
    // `updateArticleNsfwLevels` resolves to COALESCE(moderatorNsfwLevel,
    // GREATEST(...)) — so when an override is set, the effective level is
    // always identical to the override. Writing it directly skips the
    // full CTE recompute. We still queue a search index update below for
    // downstream consistency.
    const updated = await tx.article.update({
      where: { id: reviewRow.articleId },
      data: {
        moderatorNsfwLevel: appliedLevel,
        moderatorNsfwLevelBasis,
        nsfwLevel: appliedLevel,
        lockedProperties: Array.from(lockedSet),
      },
      select: { id: true, title: true },
    });

    return {
      articleId: reviewRow.articleId,
      ownerUserId: reviewRow.userId,
      previousLevel: reviewRow.currentLevel,
      derivedStatus,
      title: updated.title,
    };
  });

  articleId = result.articleId;
  ownerUserId = result.ownerUserId;
  previousLevel = result.previousLevel;
  articleTitle = result.title ?? 'your article';
  const status = result.derivedStatus;

  // Defense-in-depth: keep the search index in sync. Cheap and idempotent.
  await articlesSearchIndex
    .queueUpdate([{ id: articleId, action: SearchIndexUpdateQueueAction.Update }])
    .catch((e) => handleLogError(e, 'article-rating-review-search-index', { articleId, reviewId }));

  // Audit trail.
  await trackModActivity(moderatorId, {
    entityType: 'article',
    entityId: articleId,
    activity: 'ratingReview',
  }).catch((e) =>
    handleLogError(e, 'article-rating-review-mod-activity', {
      articleId,
      reviewId,
    })
  );

  // --- Notify the owner ---
  const previousLevelLabel = getBrowsingLevelLabel(previousLevel);
  const appliedLevelLabel = getBrowsingLevelLabel(appliedLevel);

  if (status === ReportStatus.Actioned) {
    // Granted: applied level matches the owner's suggestion.
    await createNotification({
      userId: ownerUserId,
      type: 'article-rating-review-approved',
      category: NotificationCategory.System,
      key: `article-rating-review-approved:${reviewId}`,
      details: {
        articleId,
        articleTitle,
        previousLevel: previousLevelLabel,
        newLevel: appliedLevelLabel,
        modComment: modComment ?? null,
      },
    }).catch((e) =>
      handleLogError(e, 'article-rating-review-approved-notification', {
        articleId,
        reviewId,
      })
    );
  } else {
    // Overrode differently: the owner's suggestion was not granted, but a level
    // was still applied (the mod's ruling). Copy reflects the applied level.
    await createNotification({
      userId: ownerUserId,
      type: 'article-rating-review-rejected',
      category: NotificationCategory.System,
      key: `article-rating-review-rejected:${reviewId}`,
      details: {
        articleId,
        articleTitle,
        appliedLevel: appliedLevelLabel,
        modComment: modComment ?? null,
      },
    }).catch((e) =>
      handleLogError(e, 'article-rating-review-rejected-notification', {
        articleId,
        reviewId,
      })
    );
  }

  return {
    reviewId,
    status,
    articleId,
    appliedLevel,
  };
}
