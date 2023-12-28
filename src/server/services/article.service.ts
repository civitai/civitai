import {
  ArticleEngagementType,
  Availability,
  CosmeticSource,
  CosmeticType,
  MetricTimeframe,
  Prisma,
  SearchIndexUpdateQueueAction,
  TagTarget,
} from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { ManipulateType } from 'dayjs';
import { truncate } from 'lodash-es';
import { SessionUser } from 'next-auth';

import { ArticleSort, BrowsingMode } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { eventEngine } from '~/server/events';
import {
  GetArticlesByCategorySchema,
  GetInfiniteArticlesSchema,
  UpsertArticleInput,
} from '~/server/schema/article.schema';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import { articlesSearchIndex } from '~/server/search-index';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { UserWithCosmetics, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { getCategoryTags } from '~/server/services/system-cache';
import { getTypeCategories } from '~/server/services/tag.service';
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
import { entityRequiresClub, hasEntityAccess } from '~/server/services/common.service';
import { getClubDetailsForResource, upsertClubResource } from '~/server/services/club.service';
import { profileImageSelect } from '~/server/selectors/image.selector';
import { getPrivateEntityAccessForUser } from './user-cache.service';

type ArticleRaw = {
  id: number;
  cover: string;
  title: string;
  publishedAt: Date | null;
  nsfw: boolean;
  unlisted: boolean;
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
};

export type ArticleGetAllRecord = Awaited<ReturnType<typeof getArticles>>['items'][number];

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
  browsingMode,
  followed,
  clubId,
}: GetInfiniteArticlesSchema & {
  sessionUser?: { id: number; isModerator?: boolean; username?: string };
}) => {
  try {
    const take = limit + 1;
    const isMod = sessionUser?.isModerator ?? false;
    const isOwnerRequest =
      !!sessionUser?.username &&
      !!username &&
      postgresSlugify(sessionUser.username) === postgresSlugify(username);

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
    if (browsingMode === BrowsingMode.SFW) {
      AND.push(Prisma.sql`a."nsfw" = false`);
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
    else if (sort === ArticleSort.MostTipped)
      orderBy = `rank."tippedAmountCount${period}Rank" ASC NULLS LAST, ${orderBy}`;

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
        a.title,
        a."publishedAt",
        a.nsfw,
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
          WHERE uc."userId" = a."userId"
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

    const clubRequirement = await entityRequiresClub({
      entityIds: articles.map((article) => article.id),
      entityType: 'Article',
    });

    const profilePictures = await dbRead.image.findMany({
      where: { id: { in: articles.map((a) => a.user.profilePictureId).filter(isDefined) } },
      select: { ...profileImageSelect, ingestion: true },
    });

    const articleCategories = await getCategoryTags('article');
    const userEntityAccess = await getPrivateEntityAccessForUser({ userId: sessionUser?.id });
    const privateArticleAccessIds = userEntityAccess
      .filter((x) => x.entityType === 'Article')
      .map((x) => x.entityId);

    const items = articles
      .filter((a) => {
        if (sessionUser?.isModerator || a.userId === sessionUser?.id) return true;

        // Hide posts where the user does not have permission.
        if (
          a.unlisted &&
          a.availability === Availability.Private &&
          !privateArticleAccessIds.includes(a.id)
        ) {
          return false;
        }

        return true;
      })
      .map(({ tags, stats, user, userCosmetics, cursorId, ...article }) => {
        const requiresClub =
          clubRequirement.find((r) => r.entityId === article.id)?.requiresClub ?? undefined;
        const { profilePictureId, ...u } = user;
        const profilePicture = profilePictures.find((p) => p.id === profilePictureId) ?? null;

        return {
          ...article,
          requiresClub,
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
        };
      });

    return { nextCursor, items };
  } catch (error) {
    throw throwDbError(error);
  }
};

type CivitaiNewsItemRaw = {
  id: number;
  collection: string;
  cover: string;
  title: string;
  content: string;
  publishedAt: Date;
  userId: number;
  featured: boolean;
  summary?: string;
};
export type CivitaiNewsItem = {
  id: number;
  cover: string;
  title: string;
  content: string;
  publishedAt: Date;
  user: UserWithCosmetics;
  featured: boolean;
  summary: string;
};
export const getCivitaiNews = async () => {
  const articlesRaw = await dbRead.$queryRaw<CivitaiNewsItemRaw[]>`
    SELECT
      c.name as "collection",
      a.id,
      cover,
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

  const news: CivitaiNewsItem[] = [];
  const updates: CivitaiNewsItem[] = [];
  for (const article of articlesRaw) {
    const user = users.find((x) => x.id === article.userId);
    const item = {
      ...article,
      user: user ?? null,
      summary: article.summary ?? truncate(removeTags(article.content), { length: 200 }),
    } as CivitaiNewsItem;
    if (article.collection === 'Newsroom') news.push(item);
    if (article.collection === 'Updates') updates.push(item);
  }

  const pressMentions = await dbRead.pressMention.findMany({
    orderBy: { publishedAt: 'desc' },
    where: { publishedAt: { lte: new Date() } },
  });

  return { news, updates, pressMentions };
};

export const getArticleById = async ({ id, user }: GetByIdInput & { user?: SessionUser }) => {
  try {
    const isMod = user?.isModerator ?? false;
    const [access] = await hasEntityAccess({
      userId: user?.id,
      isModerator: isMod,
      entityIds: [id],
      entityType: 'Article',
    });

    const article = await dbRead.article.findFirst({
      where: {
        id,
        OR: !isMod ? [{ publishedAt: { not: null } }, { userId: user?.id }] : undefined,
      },
      select: articleDetailSelect,
    });

    if (!article) throw throwNotFoundError(`No article with id ${id}`);
    if (!access.hasAccess && article.unlisted) throw throwAuthorizationError();

    const [entityClubDetails] = await getClubDetailsForResource({
      entityType: 'Article',
      entityIds: [article.id],
    });

    const articleCategories = await getCategoryTags('article');
    const attachments: Awaited<ReturnType<typeof getFilesByEntity>> = !access.hasAccess
      ? []
      : await getFilesByEntity({
          id,
          type: 'Article',
        });

    return {
      ...article,
      content: access.hasAccess ? article.content : null,
      attachments,
      tags: article.tags.map(({ tag }) => ({
        ...tag,
        isCategory: articleCategories.some((c) => c.id === tag.id),
      })),
      clubs: entityClubDetails?.clubs ?? [],
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const getArticlesByCategory = async ({
  user,
  cursor,
  ...input
}: GetArticlesByCategorySchema & {
  user?: SessionUser;
}) => {
  input.limit ??= 10;
  let categories = await getTypeCategories({
    type: 'article',
    excludeIds: input.excludedTagIds,
    limit: input.limit + 1,
    cursor,
  });

  let nextCursor: number | null = null;
  if (categories.length > input.limit) nextCursor = categories.pop()?.id ?? null;
  categories = categories.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Math.random() - 0.5;
  });

  const items = await Promise.all(
    categories.map((c) =>
      getArticles({
        ...input,
        limit: Math.ceil((input.articleLimit ?? 12) * 1.25),
        tags: [c.id],
        sessionUser: user,
      }).then(({ items }) => ({ ...c, items }))
    )
  );

  return { items, nextCursor };
};

export const upsertArticle = async ({
  id,
  userId,
  tags,
  attachments,
  clubs,
  ...data
}: UpsertArticleInput & { userId: number }) => {
  try {
    if (!id) {
      const result = await dbWrite.$transaction(async (tx) => {
        const article = await tx.article.create({
          data: {
            ...data,
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

      if (clubs) {
        await upsertClubResource({
          entityType: 'Article',
          entityId: result.id,
          clubs,
          userId: result.userId,
        });
      }

      return result;
    }

    const result = await dbWrite.$transaction(async (tx) => {
      const article = await tx.article.update({
        where: { id },
        data: {
          ...data,
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
      if (!article) return null;

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
              entityId: article.id,
              entityType: 'Article',
            })),
        });
      }

      return article;
    });

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

    if (clubs) {
      await upsertClubResource({
        entityType: 'Article',
        entityId: result.id,
        clubs,
        userId: result.userId,
      });
    }

    return result;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const deleteArticleById = async ({ id }: GetByIdInput) => {
  try {
    const deleted = await dbWrite.$transaction(async (tx) => {
      const article = await tx.article.delete({ where: { id } });
      if (!article) return null;

      await tx.file.deleteMany({ where: { entityId: id, entityType: 'Article' } });

      return article;
    });
    if (!deleted) throw throwNotFoundError(`No article with id ${id}`);

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
