import { ArticleEngagementType, MetricTimeframe, Prisma, TagTarget } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { SessionUser } from 'next-auth';

import { ArticleSort } from '~/server/common/enums';
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
}: GetInfiniteArticlesSchema & { sessionUser?: SessionUser }) => {
  try {
    const take = limit + 1;
    const isMod = sessionUser?.isModerator ?? false;
    const isOwnerRequest = sessionUser && sessionUser.username === username;

    const AND: Prisma.Enumerable<Prisma.ArticleWhereInput> = [];
    if (query) AND.push({ title: { contains: query } });
    if (!!tags?.length) AND.push({ tags: { some: { tagId: { in: tags } } } });
    if (!!userIds?.length) AND.push({ userId: { in: userIds } });
    if (username) AND.push({ user: { username } });

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
          },
        },
      },
      orderBy,
    });

    let nextCursor: number | undefined;
    if (articles.length > take) {
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
            favoriteCount: stats[`favoriteCount${period}`],
            commentCount: stats[`commentCount${period}`],
            likeCount: stats[`likeCount${period}`],
            dislikeCount: stats[`dislikeCount${period}`],
            heartCount: stats[`heartCount${period}`],
            laughCount: stats[`laughCount${period}`],
            cryCount: stats[`cryCount${period}`],
            viewCount: stats[`viewCount${period}`],
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
    return {
      ...article,
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
      return dbWrite.article.create({
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
          attachments: attachments
            ? {
                connectOrCreate: attachments.map((attachment) => ({
                  where: { id: attachment.id },
                  create: attachment,
                })),
              }
            : undefined,
        },
      });
    }

    const article = await dbWrite.article.update({
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
        attachments: attachments
          ? {
              deleteMany: { id: { notIn: attachments.map((x) => x.id).filter(isDefined) } },
              connectOrCreate: attachments
                .filter((x) => !!x.id)
                .map((attachment) => ({
                  where: { id: attachment.id },
                  create: attachment,
                })),
              create: attachments
                .filter((x) => !x.id)
                .map((attachment) => ({
                  ...attachment,
                })),
            }
          : undefined,
      },
    });
    if (!article) throw throwNotFoundError(`No article with id ${id}`);

    return article;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    throw throwDbError(error);
  }
};

export const deleteArticleById = async ({ id }: GetByIdInput) => {
  try {
    const article = await dbWrite.article.delete({ where: { id } });
    if (!article) throw throwNotFoundError(`No article with id ${id}`);

    return article;
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
      category: tags.at(0)?.tag,
    }));

    return getPagingData({ items, count }, take, page);
  } catch (error) {
    throw throwDbError(error);
  }
};
