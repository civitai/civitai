import { ModelType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '~/server/db/client';

export type GetAllModelsReturnType = Awaited<ReturnType<typeof getAllModels>>;

export const getAllModelsSchema = z.object({
  limit: z.number().min(1).max(100).nullish(),
  cursor: z.number().nullish(),
  query: z.string().optional(),
  tags: z.number().array().optional(),
  users: z.number().array().optional(),
  type: z.nativeEnum(ModelType).optional(),
});

export const getAllModels = async (input: z.infer<typeof getAllModelsSchema>) => {
  const limit = input.limit ?? 50;
  const { cursor } = input;
  const items = await prisma.model.findMany({
    take: limit + 1, // get an extra item at the end which we'll use as next cursor
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      OR: {
        name: {
          contains: input.query,
          mode: 'insensitive',
        },
        tagsOnModels: {
          some: {
            tagId: {
              in: input.tags,
            },
          },
        },
        userId: {
          in: input.users,
        },
        type: {
          equals: input?.type,
        },
      },
    },
    select: {
      id: true,
      name: true,
      type: true,
      imagesOnModels: {
        orderBy: {
          index: 'desc',
        },
        take: 1,
        select: {
          image: {
            select: {
              width: true,
              url: true,
              height: true,
              prompt: true,
              hash: true,
            },
          },
        },
      },
      metrics: {
        select: {
          rating: true,
          ratingCount: true,
          downloadCount: true,
        },
      },
    },
  });

  let nextCursor: typeof cursor | undefined = undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  const models = items.map(({ metrics, imagesOnModels, ...item }) => {
    const rating = Math.ceil(metrics.reduce((a, b) => a + b.rating, 0) / metrics.length);
    return {
      ...item,
      image: imagesOnModels[0]?.image ?? {},
      metrics: {
        rating: !isNaN(rating) ? rating : 0,
        ...metrics.reduce(
          (a, b) => ({
            ratingCount: a.ratingCount + b.ratingCount,
            downloadCount: a.downloadCount + b.downloadCount,
          }),
          { ratingCount: 0, downloadCount: 0 }
        ),
      },
    };
  });

  return { items: models, nextCursor };
};
