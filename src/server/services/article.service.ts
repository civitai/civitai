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
  GetInfiniteArticlesSchema,
  GetModeratorArticlesSchema,
  UpsertArticleInput,
} from '~/server/schema/article.schema';
import { articleWhereSchema } from '~/server/schema/article.schema';
import type { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import type { ImageMetaProps } from '~/server/schema/image.schema';
import type { ImageMetadata } from '~/server/schema/media.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { articlesSearchIndex } from '~/server/search-index';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { imageSelect, profileImageSelect } from '~/server/selectors/image.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';
import {
  createImage,
  deleteImageById,
  ingestImage,
  ingestImageBulk,
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
import { hashContent } from '~/server/services/entity-moderation.service';

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
  clubId,
  pending,
  browsingLevel,
  include,
}: GetInfiniteArticlesSchema & {
  sessionUser?: { id: number; isModerator?: boolean; username?: string };
  include?: Array<'cosmetics'>;
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
    // TODO.clubs: This is temporary until we are fine with displaying club stuff in public feeds.
    // At that point, we should be relying more on unlisted status which is set by the owner.
    const hidePrivateArticles =
      !ids &&
      !clubId &&
      !username &&
      !collectionId &&
      !followed &&
      !hidden &&
      !favorites &&
      !userIds;

    const AND: Prisma.Sql[] = [];
    const WITH: Prisma.Sql[] = [];

    if (query) {
      AND.push(Prisma.raw(`a."title" ILIKE '%${query}%'`));
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

      if (!targetUser) throw new Error('User not found');

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
        AND.push(Prisma.sql`a."userId" NOT IN (${Prisma.join(excludedUserIds, ',')})`);
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
      // Keyset predicate: strictly "after" (cursor.v, cursor.id) in the ordering.
      // Tiebreaker is always id DESC regardless of primary sort direction.
      const primaryOp = Prisma.raw(sortDir === 'DESC' ? '<' : '>');
      AND.push(Prisma.sql`(
        ${sortExprSql} ${primaryOp} ${cursor.v}
        OR (${sortExprSql} = ${cursor.v} AND a.id < ${cursor.id})
      )`);
    }

    if (clubId) {
      WITH.push(Prisma.sql`
      "clubArticles" AS (
        SELECT DISTINCT ON (a."id") a."id" as "articleId"
        FROM "EntityAccess" ea
        JOIN "Article" a ON a."id" = ea."accessToId"
        LEFT JOIN "ClubTier" ct ON ea."accessorType" = 'ClubTier' AND ea."accessorId" = ct."id" AND ct."clubId" = ${clubId}
        WHERE (
            (
             ea."accessorType" = 'Club' AND ea."accessorId" = ${clubId}
            )
            OR (
              ea."accessorType" = 'ClubTier' AND ct."clubId" = ${clubId}
            )
          )
          AND ea."accessToType" = 'Article'
      )
    `);
    }
    const queryWith = WITH.length > 0 ? Prisma.sql`WITH ${Prisma.join(WITH, ', ')}` : Prisma.sql``;
    const queryFrom = Prisma.sql`
      FROM "Article" a
      LEFT JOIN "User" u ON a."userId" = u.id
      LEFT JOIN "ArticleRank" rank ON rank."articleId" = a.id
      ${clubId ? Prisma.sql`JOIN "clubArticles" ca ON ca."articleId" = a."id"` : Prisma.sql``}
      WHERE ${Prisma.join(AND, ' AND ')}
    `;
    const articles = await dbRead.$queryRaw<(ArticleRaw & { cursorV: number })[]>`
      ${queryWith}
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
      select: articleDetailSelect,
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

        await userArticleCountCache.refresh(article.userId);

        return article;
      });

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

    const republishing =
      (article.status === ArticleStatus.Unpublished && data.status === ArticleStatus.Published) ||
      !!article.publishedAt;

    const prevMetadata = article.metadata as ArticleMetadata | null;

    // Set publishedAt based on status
    // - Published: Set to now for new articles, preserve for republishing
    // - Processing: Preserve existing publishedAt if article was already published (re-scan scenario)
    // - Unpublished: Preserve publishedAt so republish keeps original date
    // - Draft: Clear publishedAt (never been published)
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
      // Clear publishedAt for drafts
      publishedAt = null;
    }

    const result = await dbWrite.$transaction(async (tx) => {
      const updated = await tx.article.update({
        where: { id },
        data: {
          ...data,
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

      await userArticleCountCache.refresh(updated.userId);

      return updated;
    });

    if (!result) throw throwNotFoundError(`No article with id ${id}`);

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

    // Submit for text moderation if content or title changed (non-blocking).
    // If the article's text was emptied out entirely, drop any stale
    // EntityModeration row — otherwise the retry cron would keep re-submitting
    // and recomputeArticleIngestion could still read the old blocked/error
    // state (the hasText guard inside recompute handles the latter, but we
    // don't want a ghost row in either case).
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
        const newHash = hashContent(textForModeration);

        const existingModeration = await dbRead.entityModeration.findUnique({
          where: { entityType_entityId: { entityType: 'Article', entityId: id } },
          select: { contentHash: true },
        });

        if (!existingModeration || existingModeration.contentHash !== newHash) {
          submitTextModeration({
            entityType: 'Article',
            entityId: id,
            content: textForModeration,
            labels: ['nsfw'],
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
    }

    // Lock ingestion state and queue the search-index update. recompute also
    // queues the index update internally, so no separate queueUpdate call here.
    await recomputeArticleIngestion(id).catch((e) =>
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

    return result;
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
          publishedAt: new Date(),
          metadata: updatedMetadata,
        },
      });
    },
    { timeout: 30000, maxWait: 10000 }
  );

  // Re-derive ingestion state (also queues the search index update internally).
  // Handles the case where the article was sitting at Pending before being
  // unpublished and now needs to be re-evaluated against current image/text state.
  await recomputeArticleIngestion(id).catch((e) =>
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
    select: articleDetailSelect,
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

  const orphanedImageIds = await dbWrite.$transaction(async (tx) => {
    const imageUrls = contentImages.map((img) => img.url);

    // Track content image IDs for orphan detection
    let contentImageIds: number[] = [];

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
      const imagesToIngest = [...newlyCreatedImages, ...pendingExistingImages];
      if (imagesToIngest.length > 0) {
        // TODO.articleImageScan: remove the lowPriority flag
        for (const img of imagesToIngest) {
          await ingestImage({ image: img, lowPriority: true, userId, tx }).catch((error) => {
            handleLogError(error, 'article-image-ingestion', {
              articleId,
              imageIds: newlyCreatedImages.map((i) => i.id),
            });
          });
        }
      }
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
    if (orphanedIds.length > 0) {
      const trulyOrphaned = await tx.image.findMany({
        where: {
          id: { in: orphanedIds },
          connections: { none: {} },
        },
        select: { id: true },
      });
      return trulyOrphaned.map((img) => img.id);
    }

    return [];
  });

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
    // One atomic transaction: advisory lock → image-status read → (optional)
    // NSFW level update → ingestion recompute. Closes the drift window where
    // a crash between the NSFW update and the recompute would leave the
    // Article row with updated nsfwLevel but stale ingestion.
    const result = await dbWrite.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${articleId})`;

        const connections = await tx.imageConnection.findMany({
          where: { entityId: articleId, entityType: ImageConnectionType.Article },
          include: { image: { select: { ingestion: true } } },
        });

        const totalImages = connections.length;
        const scannedImages = connections.filter(
          (c) => c.image.ingestion === ImageIngestionStatus.Scanned
        ).length;
        const blockedImages = connections.filter(
          (c) => c.image.ingestion === ImageIngestionStatus.Blocked
        ).length;
        const errorImages = connections.filter(
          (c) =>
            c.image.ingestion === ImageIngestionStatus.Error ||
            c.image.ingestion === ImageIngestionStatus.NotFound
        ).length;

        const allProcessed = scannedImages + blockedImages + errorImages === totalImages;

        if (allProcessed) {
          await updateArticleNsfwLevels([articleId], tx);
        }

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

  // --- Image side ---
  const connections = await tx.imageConnection.findMany({
    where: { entityId: articleId, entityType: ImageConnectionType.Article },
    include: { image: { select: { ingestion: true } } },
  });

  const totalImages = connections.length;
  const scannedImages = connections.filter(
    (c) => c.image.ingestion === ImageIngestionStatus.Scanned
  ).length;
  const blockedImages = connections.filter(
    (c) => c.image.ingestion === ImageIngestionStatus.Blocked
  ).length;
  const errorImages = connections.filter(
    (c) =>
      c.image.ingestion === ImageIngestionStatus.Error ||
      c.image.ingestion === ImageIngestionStatus.NotFound
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

  const current = await tx.article.findUniqueOrThrow({
    where: { id: articleId },
    select: {
      ingestion: true,
      status: true,
      publishedAt: true,
      userId: true,
      title: true,
      content: true,
    },
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

  // --- Derive ingestion state ---
  let next: ArticleIngestionStatus;
  if (imageBlocked || textBlocked) {
    next = ArticleIngestionStatus.Blocked;
  } else if (imageError || textError) {
    next = ArticleIngestionStatus.Error;
  } else if (imageDone && textDone) {
    next = ArticleIngestionStatus.Scanned;
  } else {
    next = ArticleIngestionStatus.Pending;
  }

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
    include: { image: { select: { id: true, url: true, ingestion: true } } },
  });

  for (const conn of connections) {
    if (conn.image.ingestion === ImageIngestionStatus.Pending) continue;
    await ingestImage({ image: conn.image, lowPriority: true, userId: article.userId }).catch(
      (err) => {
        handleLogError(err, 'article-rescan-image', { articleId: id, imageId: conn.image.id });
      }
    );
  }

  // --- Clear content hash and re-submit text moderation ---
  await dbWrite.entityModeration.updateMany({
    where: { entityType: 'Article', entityId: id },
    data: { contentHash: null },
  });

  if (article.content) {
    const textForModeration = [article.title, removeTags(article.content)]
      .filter(Boolean)
      .join(' ');

    await submitTextModeration({
      entityType: 'Article',
      entityId: id,
      content: textForModeration,
      labels: ['nsfw'],
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
