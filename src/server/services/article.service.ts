import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import type { ManipulateType } from 'dayjs';
import { truncate } from 'lodash-es';
import { ImageConnectionType, NotificationCategory, NsfwLevel } from '~/server/common/enums';
import { ArticleSort, SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import { userArticleCountCache, articleStatCache } from '~/server/redis/caches';
import { logToAxiom } from '~/server/logging/client';
import type {
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
import { articlesSearchIndex } from '~/server/search-index';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import type { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { imageSelect, profileImageSelect } from '~/server/selectors/image.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import { createProfanityFilter } from '~/libs/profanity-simple';
import { filterSensitiveProfanityData } from '~/libs/profanity-simple/helpers';
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
  ArticleStatus,
  Availability,
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
import { createNotification } from '~/server/services/notification.service';
import { updateArticleNsfwLevels } from '~/server/services/nsfwLevels.service';
import { extractImagesFromArticle } from '~/server/utils/article-image-helpers';

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
      const targetUser = await dbRead.user.findUnique({
        where: { username: username ?? '' },
        select: { id: true },
      });

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

    let orderBy = `a."publishedAt" DESC NULLS LAST`;
    if (sort === ArticleSort.MostBookmarks)
      orderBy = `rank."collectedCount${period}Rank" ASC NULLS LAST, ${orderBy}`;
    else if (sort === ArticleSort.MostComments)
      orderBy = `rank."commentCount${period}Rank" ASC NULLS LAST, ${orderBy}`;
    else if (sort === ArticleSort.MostReactions)
      orderBy = `rank."reactionCount${period}Rank" ASC NULLS LAST, ${orderBy}`;
    else if (sort === ArticleSort.MostCollected)
      orderBy = `rank."collectedCount${period}Rank" ASC NULLS LAST, ${orderBy}`;
    else if (sort === ArticleSort.RecentlyUpdated)
      orderBy = `a."updatedAt" DESC NULLS LAST, ${orderBy}`;

    // eslint-disable-next-line prefer-const
    let [cursorProp, cursorDirection] = orderBy?.split(' ');

    if (cursorProp === 'a."publishedAt"' || cursorProp === 'a."updatedAt"') {
      // treats a date as a number of seconds since epoch
      cursorProp = `extract(epoch from ${cursorProp})`;
    }

    if (cursor) {
      const cursorOperator = cursorDirection === 'DESC' ? '<' : '>';
      AND.push(Prisma.sql`${Prisma.raw(cursorProp)} ${Prisma.raw(cursorOperator)} ${cursor}`);
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
    const articles = await dbRead.$queryRaw<(ArticleRaw & { cursorId: number })[]>`
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
        ${Prisma.raw(cursorProp ? cursorProp : 'null')} as "cursorId"
      ${queryFrom}
      ORDER BY ${Prisma.raw(orderBy)}
      LIMIT ${take}
    `;

    let nextCursor: number | undefined;
    if (articles.length > limit) {
      const nextItem = articles.pop();
      nextCursor = nextItem?.cursorId || undefined;
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
      .map(({ tags, user, userCosmetics, cursorId, ...article }) => {
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
                // !important - when article `userNsfwLevel` equals article `nsfwLevel`, it's possible that the article `userNsfwLevel` is higher than the cover image `nsfwLevel`. In this case, we update the image to the higher `nsfwLevel` so that it will still pass through front end filters
                nsfwLevel:
                  article.nsfwLevel === article.userNsfwLevel
                    ? article.nsfwLevel
                    : coverImage.nsfwLevel,
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
  const events = await getArticles({ ...input, limit: 100, sessionUser: undefined });
  return events;
};

export type ArticleGetById = AsyncReturnType<typeof getArticleById>;
export const getArticleById = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId?: number; isModerator?: boolean }) => {
  try {
    const article = await dbRead.article.findFirst({
      where: {
        id,
        OR: !isModerator
          ? [{ publishedAt: { not: null }, status: ArticleStatus.Published }, { userId }]
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

    let contentJson: Record<string, any> | undefined;
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
      metadata: article.metadata
        ? filterSensitiveProfanityData(article.metadata as ArticleMetadata, isModerator)
        : null,
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
  nsfw?: boolean;
  metadata?: ArticleMetadata;
  scanContent?: boolean;
}) => {
  try {
    await throwOnBlockedLinkDomain(data.content);
    if (!isModerator) {
      // don't allow updating of locked properties
      for (const key of data.lockedProperties ?? []) delete data[key as keyof typeof data];

      // Check article title and content for profanity using threshold-based evaluation
      const profanityFilter = createProfanityFilter();
      const textToCheck = [data.title, data.content].filter(Boolean).join(' ');
      const evaluation = profanityFilter.evaluateContent(textToCheck);

      // If profanity exceeds thresholds, mark article as NSFW with recommended level
      if (evaluation.shouldMarkNSFW && (data.userNsfwLevel <= NsfwLevel.PG13 || !data.nsfw)) {
        data.metadata = {
          ...data.metadata,
          profanityMatches: evaluation.matchedWords,
          profanityEvaluation: {
            reason: evaluation.reason,
            metrics: evaluation.metrics,
          },
        } as ArticleMetadata;
        data.nsfw = true;
        data.userNsfwLevel = evaluation.suggestedLevel;
        data.lockedProperties =
          data.lockedProperties && !data.lockedProperties.includes('userNsfwLevel')
            ? [...data.lockedProperties, 'nsfw', 'userNsfwLevel']
            : ['nsfw', 'userNsfwLevel'];
      }
    }

    // TODO make coverImage required here and in db
    // create image entity to be attached to article
    let coverId = coverImage?.id;
    if (coverImage) {
      if (!coverId) {
        const result = await createImage({ ...coverImage, userId });
        coverId = result.id;
      } else {
        const isImgOwner = await isImageOwner({ userId, isModerator, imageId: coverId });
        if (!isImgOwner) {
          throw throwAuthorizationError('Invalid cover image');
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

        await userArticleCountCache.bust(article.userId);

        return article;
      });

      // Link content images for new article (creates Image entities and ImageConnections)
      if (result.content && scanContent) {
        try {
          await linkArticleContentImages({
            articleId: result.id,
            content: result.content,
            userId,
          });

          // Mark article as scanned after successfully linking images
          await dbWrite.article.update({
            where: { id: result.id },
            data: { contentScannedAt: new Date() },
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

      return result;
    }

    const article = await dbWrite.article.findUnique({
      where: { id },
      select: {
        id: true,
        cover: true,
        coverId: true,
        userId: true,
        publishedAt: true,
        status: true,
        nsfwLevel: true,
        metadata: true,
        content: true, // Add content for change detection
      },
    });
    if (!article) throw throwNotFoundError();

    const isOwner = article.userId === userId || isModerator;
    if (!isOwner) throw throwAuthorizationError('You cannot perform this action');

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

      await userArticleCountCache.bust(updated.userId);

      return updated;
    });

    if (!result) throw throwNotFoundError(`No article with id ${id}`);

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
          await linkArticleContentImages({
            articleId: id,
            content: data.content,
            userId,
          });

          // Mark article as scanned after successfully linking images
          await dbWrite.article.update({
            where: { id },
            data: { contentScannedAt: new Date() },
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
    }

    await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

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

    const deleted = await dbWrite.$transaction(async (tx) => {
      const article = await tx.article.delete({ where: { id }, select: { coverId: true } });

      await tx.file.deleteMany({ where: { entityId: id, entityType: 'Article' } });
      await tx.imageConnection.deleteMany({
        where: { entityId: id, entityType: ImageConnectionType.Article },
      });

      return article;
    });

    if (deleted.coverId) await deleteImageById({ id: deleted.coverId });
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

    const articles = await dbRead.article.findMany({
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
    const count = await dbRead.article.count({ where });

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
  const article = await dbRead.article.findUnique({
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
  await userArticleCountCache.bust(article.userId);

  return updated;
}

export async function restoreArticleById({ id, userId }: { id: number; userId: number }) {
  const article = await dbRead.article.findUnique({
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

  // Re-add to search index
  await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);

  await userArticleCountCache.bust(article.userId);

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
}: {
  articleId: number;
  content: string;
  userId: number;
}): Promise<void> {
  const contentImages = extractImagesFromArticle(content);
  if (contentImages.length === 0) return;

  await dbWrite.$transaction(async (tx) => {
    const imageUrls = contentImages.map((img) => img.url);

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
        skipDuplicates: true, // Handle race conditions
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
        create: { imageId: image.id, entityType: ImageConnectionType.Article, entityId: articleId },
        update: {},
      });
    }

    // Remove orphaned connections (images deleted from content)
    const contentImageIds = Array.from(existingUrlMap.values()).map((img) => img.id);

    // Get orphaned connections for this article
    const orphanedConnections = await tx.imageConnection.findMany({
      where: {
        entityType: ImageConnectionType.Article,
        entityId: articleId,
        imageId: { notIn: contentImageIds },
      },
      select: { imageId: true },
    });

    const orphanedImageIds = orphanedConnections.map((conn) => conn.imageId);

    // Delete the orphaned connections (safe - only affects this article)
    await tx.imageConnection.deleteMany({
      where: {
        entityType: ImageConnectionType.Article,
        entityId: articleId,
        imageId: { notIn: contentImageIds },
      },
    });

    // SAFETY: Only delete images that have NO remaining connections to ANY entity
    // This prevents data loss when images are shared across multiple articles/entities
    if (orphanedImageIds.length > 0) {
      const trulyOrphanedImages = await tx.image.findMany({
        where: {
          id: { in: orphanedImageIds },
          connections: { none: {} }, // Critical check: no connections to ANY entity
        },
        select: { id: true },
      });

      if (trulyOrphanedImages.length > 0) {
        await tx.image.deleteMany({
          where: {
            id: { in: trulyOrphanedImages.map((img) => img.id) },
          },
        });
      }
    }

    const pendingExistingImages = existingImages.filter(
      (img) => img.ingestion === ImageIngestionStatus.Pending
    );
    const imagesToIngest = [...newlyCreatedImages, ...pendingExistingImages];

    // Queue newly created images for immediate ingestion
    if (imagesToIngest.length > 0) {
      // TODO.articleImageScan: remove the lowPriority flag
      for (const img of imagesToIngest) {
        await ingestImage({ image: img, lowPriority: true, userId, tx }).catch((error) => {
          // Log error but don't fail the article operation
          handleLogError(error, 'article-image-ingestion', {
            articleId,
            imageIds: newlyCreatedImages.map((i) => i.id),
          });
        });
      }
    }
  });
}

/**
 * Get article image scan status for real-time progress tracking
 *
 * @param articleId - Article ID to get scan status for
 * @returns Object with scan progress counts, completion status, and detailed image lists
 */
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
}> {
  const connections = await dbRead.imageConnection.findMany({
    where: {
      entityId: id,
      entityType: ImageConnectionType.Article,
    },
    include: { image: { select: { id: true, url: true, ingestion: true, blockedFor: true } } },
  });

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

  return {
    total,
    scanned: scannedImages.length,
    blocked: blockedImages.length,
    error: errorImages.length,
    pending: pendingImages.length,
    allComplete: pendingImages.length === 0,
    images: {
      blocked: blockedImages.map((c) => c.image),
      error: errorImages.map((c) => c.image),
      pending: pendingImages.map((c) => c.image),
    },
  };
}

/**
 * Update article scan status after images complete scanning
 *
 * Uses PostgreSQL advisory locks to prevent race conditions from concurrent webhook calls
 * Implements transaction-safe status updates with automatic rollback on errors
 *
 * @param articleIds - Array of article IDs to update
 */
export async function updateArticleImageScanStatus(articleIds: number[]): Promise<void> {
  for (const articleId of articleIds) {
    await dbWrite.$transaction(
      async (tx) => {
        // Acquire PostgreSQL advisory lock (prevents concurrent webhooks)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${articleId})`;

        // Get all connected images
        const connections = await tx.imageConnection.findMany({
          where: { entityId: articleId, entityType: ImageConnectionType.Article },
          include: { image: { select: { ingestion: true } } },
        });

        // Calculate scan status
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

        // Check if all images have been processed (scanned, blocked, or error)
        const allProcessed = scannedImages + blockedImages + errorImages === totalImages;

        // Only publish if ALL images scanned successfully (no blocked or error images)
        const allScannedSuccessfully = scannedImages === totalImages;
        const hasProblematicImages = blockedImages > 0 || errorImages > 0;

        if (allProcessed) {
          await updateArticleNsfwLevels([articleId]);

          const article = await tx.article.findUnique({
            where: { id: articleId },
            select: { status: true, publishedAt: true, userId: true },
          });

          if (article?.status === ArticleStatus.Processing) {
            if (allScannedSuccessfully && !hasProblematicImages) {
              // All images scanned successfully - safe to publish
              await tx.article.update({
                where: { id: articleId },
                data: {
                  status: ArticleStatus.Published,
                  publishedAt: article.publishedAt || new Date(),
                },
              });

              // Success notification
              await createNotification({
                userId: article.userId,
                category: NotificationCategory.System,
                type: 'system-message',
                key: `article-published-${articleId}`,
                details: {
                  message: `Your article has been published successfully!`,
                  url: `/articles/${articleId}`,
                },
              });
            } else if (hasProblematicImages) {
              // Has blocked or error images - keep in Processing, notify user
              await createNotification({
                userId: article.userId,
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
              });
            }
          }
        }
      },
      { timeout: 30000, maxWait: 10000 }
    );
  }
}
