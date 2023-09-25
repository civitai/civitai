import {
  ArticleEngagementType,
  MetricTimeframe,
  Prisma,
  SearchIndexUpdateQueueAction,
  TagTarget,
} from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { SessionUser } from 'next-auth';

import { ArticleSort, BrowsingMode } from '~/server/common/enums';
import {
  GetArticlesByCategorySchema,
  GetInfiniteArticlesSchema,
  UpsertArticleInput,
} from '~/server/schema/article.schema';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetAllSchema, GetByIdInput } from '~/server/schema/base.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getTypeCategories } from '~/server/services/tag.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { getPagination, getPagingData } from '~/server/utils/pagination-helpers';
import { getCategoryTags } from '~/server/services/system-cache';
import { isDefined } from '~/utils/type-guards';
import { decreaseDate } from '~/utils/date-helpers';
import { ManipulateType } from 'dayjs';
import { articlesSearchIndex } from '~/server/search-index';
import {
  getAvailableCollectionItemsFilterForUser,
  getUserCollectionPermissionsById,
} from '~/server/services/collection.service';
import { getFilesByEntity } from './file.service';

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
}: GetInfiniteArticlesSchema & { sessionUser?: SessionUser }) => {
  try {
    const take = limit + 1;
    const isMod = sessionUser?.isModerator ?? false;
    const isOwnerRequest = sessionUser && sessionUser.username === username;

    const AND: Prisma.Enumerable<Prisma.ArticleWhereInput> = [];
    if (query) AND.push({ title: { contains: query } });
    if (!!tags?.length) AND.push({ tags: { some: { tagId: { in: tags } } } });
    if (!!userIds?.length) AND.push({ userId: { in: userIds } });
    if (!!ids?.length) AND.push({ id: { in: ids } });
    if (browsingMode === BrowsingMode.SFW) AND.push({ nsfw: false });
    if (username) AND.push({ user: { username } });
    if (collectionId) {
      const permissions = await getUserCollectionPermissionsById({
        userId: sessionUser?.id,
        id: collectionId,
      });

      if (!permissions.read) {
        return { items: [] };
      }

      const collectionItemModelsAND: Prisma.Enumerable<Prisma.CollectionItemWhereInput> =
        getAvailableCollectionItemsFilterForUser({ permissions, userId: sessionUser?.id });

      AND.push({
        collectionItems: {
          some: {
            collectionId,
            AND: collectionItemModelsAND,
          },
        },
      });
    }

    if (!isOwnerRequest) {
      if (!!excludedUserIds?.length) AND.push({ userId: { notIn: excludedUserIds } });
      if (!!excludedIds?.length) AND.push({ id: { notIn: excludedIds } });
      if (!!excludedTagIds?.length) AND.push({ tags: { none: { tagId: { in: excludedTagIds } } } });
    }

    if (sessionUser) {
      if (favorites) {
        AND.push({
          engagements: { some: { userId: sessionUser?.id, type: ArticleEngagementType.Favorite } },
        });
      } else if (hidden) {
        AND.push({
          engagements: { some: { userId: sessionUser?.id, type: ArticleEngagementType.Hide } },
        });
      }
    }

    const where: Prisma.ArticleFindManyArgs['where'] = {
      publishedAt:
        isMod && includeDrafts
          ? undefined
          : period !== MetricTimeframe.AllTime && periodMode !== 'stats'
          ? { gte: decreaseDate(new Date(), 1, period.toLowerCase() as ManipulateType) }
          : { not: null },
      AND: AND.length ? AND : undefined,
    };

    const orderBy: Prisma.ArticleFindManyArgs['orderBy'] = [
      { publishedAt: { sort: 'desc', nulls: 'last' } },
    ];
    if (sort === ArticleSort.MostBookmarks)
      orderBy.unshift({ rank: { [`favoriteCount${period}Rank`]: 'asc' } });
    else if (sort === ArticleSort.MostComments)
      orderBy.unshift({ rank: { [`commentCount${period}Rank`]: 'asc' } });
    else if (sort === ArticleSort.MostReactions)
      orderBy.unshift({ rank: { [`reactionCount${period}Rank`]: 'asc' } });
    else if (sort === ArticleSort.MostCollected)
      orderBy.unshift({ rank: { [`collectedCount${period}Rank`]: 'asc' } });

    const articles = await dbRead.article.findMany({
      take,
      cursor: cursor ? { id: cursor } : undefined,
      where,
      select: {
        id: true,
        cover: true,
        title: true,
        publishedAt: true,
        nsfw: true,
        user: { select: userWithCosmeticsSelect },
        tags: { select: { tag: { select: simpleTagSelect } } },
        stats: {
          select: {
            [`favoriteCount${period}`]: true,
            [`commentCount${period}`]: true,
            [`likeCount${period}`]: true,
            [`dislikeCount${period}`]: true,
            [`heartCount${period}`]: true,
            [`laughCount${period}`]: true,
            [`cryCount${period}`]: true,
            [`viewCount${period}`]: true,
            [`tippedAmountCount${period}`]: true,
          },
        },
      },
      orderBy,
    });

    let nextCursor: number | undefined;
    if (articles.length > limit) {
      const nextItem = articles.pop();
      nextCursor = nextItem?.id;
    }

    const articleCategories = await getCategoryTags('article');
    const items = articles.map(({ tags, stats, ...article }) => ({
      ...article,
      tags: tags.map(({ tag }) => ({
        ...tag,
        isCategory: articleCategories.some((c) => c.id === tag.id),
      })),
      stats: stats
        ? {
            favoriteCount: stats[`favoriteCount${period}`] as number,
            commentCount: stats[`commentCount${period}`] as number,
            likeCount: stats[`likeCount${period}`] as number,
            dislikeCount: stats[`dislikeCount${period}`] as number,
            heartCount: stats[`heartCount${period}`] as number,
            laughCount: stats[`laughCount${period}`] as number,
            cryCount: stats[`cryCount${period}`] as number,
            viewCount: stats[`viewCount${period}`] as number,
            tippedAmountCount: stats[`tippedAmountCount${period}`] as number,
          }
        : undefined,
    }));

    return { nextCursor, items };
  } catch (error) {
    throw throwDbError(error);
  }
};

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
    const attachments = await getFilesByEntity({ id, type: 'Article' });

    return {
      ...article,
      attachments,
      tags: article.tags.map(({ tag }) => ({
        ...tag,
        isCategory: articleCategories.some((c) => c.id === tag.id),
      })),
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
