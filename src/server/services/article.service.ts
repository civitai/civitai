import {
  ArticleEngagementType,
  Availability,
  CosmeticSource,
  CosmeticType,
  MetricTimeframe,
  Prisma,
  TagTarget,
} from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { TRPCError } from '@trpc/server';
import { ManipulateType } from 'dayjs';
import { truncate } from 'lodash-es';
import { SessionUser } from 'next-auth';

import { ArticleSort, NsfwLevel } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import {
  articleWhereSchema,
  GetInfiniteArticlesSchema,
  UpsertArticleInput,
} from '~/server/schema/article.schema';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import { articlesSearchIndex } from '~/server/search-index';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { getCategoryTags } from '~/server/services/system-cache';
import {
  throwAuthorizationError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { decreaseDate } from '~/utils/date-helpers';
import { postgresSlugify, removeTags } from '~/utils/string-helpers';
import { isDefined } from '~/utils/type-guards';
import { getFilesByEntity } from './file.service';
import { imageSelect, profileImageSelect } from '~/server/selectors/image.selector';
import { createImage, deleteImageById } from '~/server/services/image.service';
import { ImageMetaProps } from '~/server/schema/image.schema';
import { ContentDecorationCosmetic, WithClaimKey } from '~/server/selectors/cosmetic.selector';
import { getCosmeticsForEntity } from '~/server/services/cosmetic.service';

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
  stats:
    | {
        favoriteCount: number;
        commentCount: number;
        likeCount: number;
        dislikeCount: number;
        heartCount: number;
        laughCount: number;
        cryCount: number;
        viewCount: number;
        tippedAmountCount: number;
      }
    | undefined;
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
      !!username &&
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
        : Prisma.sql`a."publishedAt" IS NOT NULL`;

    if (publishedAtFilter) {
      AND.push(publishedAtFilter);
    }

    let orderBy = `a."publishedAt" DESC NULLS LAST`;
    if (sort === ArticleSort.MostBookmarks)
      orderBy = `rank."favoriteCount${period}Rank" ASC NULLS LAST, ${orderBy}`;
    else if (sort === ArticleSort.MostComments)
      orderBy = `rank."commentCount${period}Rank" ASC NULLS LAST, ${orderBy}`;
    else if (sort === ArticleSort.MostReactions)
      orderBy = `rank."reactionCount${period}Rank" ASC NULLS LAST, ${orderBy}`;
    else if (sort === ArticleSort.MostCollected)
      orderBy = `rank."collectedCount${period}Rank" ASC NULLS LAST, ${orderBy}`;
    // else if (sort === ArticleSort.MostTipped)
    //   orderBy = `rank."tippedAmountCount${period}Rank" ASC NULLS LAST, ${orderBy}`;

    // eslint-disable-next-line prefer-const
    let [cursorProp, cursorDirection] = orderBy?.split(' ');

    if (cursorProp === 'a."publishedAt"') {
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
      LEFT JOIN "ArticleStat" stats ON stats."articleId" = a.id
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
        ${Prisma.raw(`
        jsonb_build_object(
          'favoriteCount', stats."favoriteCount${period}",
          'commentCount', stats."commentCount${period}",
          'likeCount', stats."likeCount${period}",
          'dislikeCount', stats."dislikeCount${period}",
          'heartCount', stats."heartCount${period}",
          'cryCount', stats."cryCount${period}",
          'viewCount', stats."viewCount${period}",
          'tippedAmountCount', stats."tippedAmountCount${period}"
        ) as "stats",
        `)}
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

    const items = articles
      .filter((a) => {
        // This take prio over mod status just so mods can see the same as users.
        if (hidePrivateArticles && a.availability === Availability.Private) return false;
        if (sessionUser?.isModerator || a.userId === sessionUser?.id) return true;

        return true;
      })
      .map(({ tags, stats, user, userCosmetics, cursorId, ...article }) => {
        const { profilePictureId, ...u } = user;
        const profilePicture = profilePictures.find((p) => p.id === profilePictureId) ?? null;
        const coverImage = coverImages.find((x) => x.id === article.coverId);

        return {
          ...article,
          tags: tags.map(({ tag }) => ({
            ...tag,
            isCategory: articleCategories.some((c) => c.id === tag.id),
          })),
          stats,
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
                metadata: coverImage.metadata as any,
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
export const getArticleById = async ({ id, user }: GetByIdInput & { user?: SessionUser }) => {
  try {
    const isMod = user?.isModerator ?? false;
    const article = await dbRead.article.findFirst({
      where: {
        id,
        OR: !isMod ? [{ publishedAt: { not: null } }, { userId: user?.id }] : undefined,
      },
      select: articleDetailSelect,
    });

    if (!article) throw throwNotFoundError(`No article with id ${id}`);

    const articleCategories = await getCategoryTags('article');
    const attachments: Awaited<ReturnType<typeof getFilesByEntity>> = await getFilesByEntity({
      id,
      type: 'Article',
    });

    return {
      ...article,
      nsfwLevel: article.nsfwLevel as NsfwLevel,
      attachments,
      tags: article.tags.map(({ tag }) => ({
        ...tag,
        isCategory: articleCategories.some((c) => c.id === tag.id),
      })),
      coverImage: article.coverImage
        ? {
            ...article.coverImage,
            nsfwLevel: article.coverImage.nsfwLevel as NsfwLevel,
            meta: article.coverImage.meta as ImageMetaProps,
            metadata: article.coverImage.metadata as any,
            tags: article.coverImage?.tags.flatMap((x) => x.tag.id),
          }
        : undefined,
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
  ...data
}: UpsertArticleInput & { userId: number; isModerator?: boolean }) => {
  try {
    // create image entity to be attached to article
    let coverId = coverImage?.id;
    if (coverImage && !coverImage.id) {
      const result = await createImage({ ...coverImage, userId });
      coverId = result.id;
    }

    if (!id) {
      const result = await dbWrite.$transaction(async (tx) => {
        const article = await tx.article.create({
          data: {
            ...data,
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

      return result;
    }

    const article = await dbWrite.article.findUnique({
      where: { id },
      select: { id: true, cover: true, coverId: true, userId: true },
    });
    if (!article) throw throwNotFoundError();

    const isOwner = article.userId === userId || isModerator;
    if (!isOwner) throw throwAuthorizationError('You cannot perform this action');

    const result = await dbWrite.$transaction(async (tx) => {
      const updated = await tx.article.update({
        where: { id },
        data: {
          ...data,
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

    // remove old cover image
    if (article.coverId !== coverId && article.coverId) {
      await deleteImageById({ id: article.coverId });
    }

    if (!result) throw throwNotFoundError(`No article with id ${id}`);

    // If it was unpublished, need to remove it from the queue.
    if (!result.publishedAt) {
      await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Delete }]);
    }

    // If tags changed, need to set is so it updates the queue.
    if (tags) {
      await articlesSearchIndex.queueUpdate([{ id, action: SearchIndexUpdateQueueAction.Update }]);
    }

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
      publishedAt: null,
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

// TODO.Briant - remove this after done updating article images
export async function getAllArticlesForImageProcessing() {
  return await dbRead.article.findMany({
    select: {
      id: true,
      cover: true,
      coverId: true,
      userId: true,
      coverImage: { select: { scannedAt: true, ingestion: true } },
    },
  });
}
