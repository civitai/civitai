import { MetricTimeframe, ModelType } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '~/server/db/client';
import { ModelSort } from '~/server/common/enums';

export type GetAllModelsReturnType = Awaited<ReturnType<typeof getAllModels>>;

const timeframeDaysMap: Record<MetricTimeframe, number> = {
  [MetricTimeframe.Day]: 1,
  [MetricTimeframe.Week]: 7,
  [MetricTimeframe.Month]: 30,
  [MetricTimeframe.Year]: 365,
  [MetricTimeframe.AllTime]: 365 * 10,
};

const getSinceDate = (timeframe: MetricTimeframe) => {
  const sinceDate = new Date();
  sinceDate.setDate(sinceDate.getDate() - timeframeDaysMap[timeframe]);
  return sinceDate;
};

export const getAllModelsSchema = z.object({
  limit: z.number().min(1).max(200).optional(),
  cursor: z.number().nullish(),
  query: z.string().optional(),
  tag: z.string().optional(),
  user: z.string().optional(),
  type: z.nativeEnum(ModelType).optional(),
  sort: z.nativeEnum(ModelSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
});

export const getAllModels = async (input: z.infer<typeof getAllModelsSchema>) => {
  const { cursor, limit = 50, period = MetricTimeframe.AllTime } = input;
  console.log('___INPUT___');
  console.log({ input });
  const items = await prisma.model.findMany({
    take: limit + 1, // get an extra item at the end which we'll use as next cursor
    cursor: cursor ? { id: cursor } : undefined,
    where: {
      // only return items that have been ranked
      // rank: input.sort ? { modelId: { not: undefined } } : undefined,
      createdAt:
        period !== MetricTimeframe.AllTime
          ? {
              gte: getSinceDate(period),
            }
          : undefined,
      name: input.query
        ? {
            contains: input.query,
            mode: 'insensitive',
          }
        : undefined,
      tagsOnModels: input.tag
        ? {
            some: {
              tag: {
                name: input.tag,
              },
            },
          }
        : undefined,
      user: input.user
        ? {
            name: input.user,
          }
        : undefined,

      type: input.type
        ? {
            equals: input?.type,
          }
        : undefined,
    },
    orderBy: [
      ...(input.sort === ModelSort.HighestRated
        ? [
            {
              rank: {
                [`rating${period}`]: 'desc',
              },
            },
          ]
        : []),
      ...(input.sort === ModelSort.MostDownloaded
        ? [
            {
              rank: {
                [`downloadCount${period}`]: 'desc',
              },
            },
          ]
        : []),
      {
        createdAt: 'desc',
      },
    ],
    select: {
      id: true,
      name: true,
      type: true,
      modelVersions: {
        orderBy: {
          id: 'asc',
        },
        take: 1,
        select: {
          images: {
            orderBy: {
              index: 'asc',
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
        },
      },
      rank: {
        select: {
          downloadCountAllTime: true,
          ratingCountAllTime: true,
          ratingAllTime: true,
        },
      },
    },
  });

  let nextCursor: typeof cursor | undefined = undefined;
  if (items.length > limit) {
    const nextItem = items.pop();
    nextCursor = nextItem?.id;
  }

  const models = items.map(({ rank, modelVersions, ...item }) => {
    return {
      ...item,
      image: modelVersions[0]?.images[0]?.image ?? {},
      rank: {
        downloadCount: rank?.downloadCountAllTime,
        ratingCount: rank?.ratingCountAllTime,
        rating: rank?.ratingAllTime,
      },
    };
  });

  return { items: models, nextCursor };
};
