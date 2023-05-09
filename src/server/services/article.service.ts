import { Prisma, TagTarget } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { SessionUser } from 'next-auth';

import { ArticleSort } from '~/server/common/enums';
import {
  GetArticlesByCategorySchema,
  GetInfiniteArticlesSchema,
  UpsertArticleInput,
} from '~/server/schema/article.schema';
import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { isNotTag, isTag } from '~/server/schema/tag.schema';
import { articleDetailSelect } from '~/server/selectors/article.selector';
import { simpleTagSelect } from '~/server/selectors/tag.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getTypeCategories } from '~/server/services/tag.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';

export const getArticles = async ({
  limit,
  cursor,
  query,
  tags,
  period,
  sort,
  browsingMode,
  user,
}: GetInfiniteArticlesSchema & { user?: SessionUser }) => {
  try {
    const take = limit + 1;
    const isMod = user?.isModerator ?? false;

    const AND: Prisma.Enumerable<Prisma.ArticleWhereInput> = [];

    if (query) AND.push({ title: { contains: query } });
    if (!!tags?.length) AND.push({ tags: { some: { tagId: { in: tags } } } });

    const where: Prisma.ArticleFindManyArgs['where'] = {
      publishedAt: isMod ? undefined : { not: null },
      AND,
    };

    const orderBy: Prisma.ArticleFindManyArgs['orderBy'] = {};
    if (sort === ArticleSort.Newest) orderBy.publishedAt = 'desc';

    const articles = await dbRead.article.findMany({
      take,
      cursor: cursor ? { id: cursor } : undefined,
      where,
      select: {
        id: true,
        cover: true,
        title: true,
        publishedAt: true,
        user: { select: userWithCosmeticsSelect },
        tags: { select: { tag: { select: simpleTagSelect } } },
      },
      orderBy,
    });

    let nextCursor: number | undefined;
    if (articles.length > take) {
      const nextItem = articles.pop();
      nextCursor = nextItem?.id;
    }

    const items = articles.map(({ tags, ...article }) => ({
      ...article,
      tags: tags.map(({ tag }) => tag),
    }));

    return { nextCursor, items };
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getArticleById = async ({ id }: GetByIdInput) => {
  try {
    const article = await dbRead.article.findUnique({
      where: { id },
      select: articleDetailSelect,
    });
    if (!article) throw throwNotFoundError(`No article with id ${id}`);

    return { ...article, tags: article.tags.map(({ tag }) => tag) };
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
    type: 'model',
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
        user,
      }).then(({ items }) => ({ ...c, items }))
    )
  );

  return { items, nextCursor };
};

export const upsertArticle = async ({
  id,
  userId,
  tags,
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
