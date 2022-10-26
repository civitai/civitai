import { MetricTimeframe, ModelType, Prisma } from '@prisma/client';
import { z } from 'zod';
import { ModelSort } from '~/server/common/enums';

// const timeframeDaysMap: Record<MetricTimeframe, number> = {
//   [MetricTimeframe.Day]: 1,
//   [MetricTimeframe.Week]: 7,
//   [MetricTimeframe.Month]: 30,
//   [MetricTimeframe.Year]: 365,
//   [MetricTimeframe.AllTime]: 365 * 10,
// };

// const getSinceDate = (timeframe: MetricTimeframe) => {
//   const sinceDate = new Date();
//   sinceDate.setDate(sinceDate.getDate() - timeframeDaysMap[timeframe]);
//   return sinceDate;
// };

export const getAllModelsSchema = z.object({
  limit: z.number().min(1).max(200).optional(),
  cursor: z.number().nullish(),
  query: z.string().optional(),
  tag: z.string().optional(),
  user: z.string().optional(),
  type: z.nativeEnum(ModelType).optional(),
  sort: z.nativeEnum(ModelSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  showNsfw: z.boolean().optional(),
});

export const getAllModelsWhere = (input: z.infer<typeof getAllModelsSchema>) =>
  Prisma.validator<Prisma.ModelWhereInput>()({
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
    nsfw: input.showNsfw
      ? undefined
      : {
          equals: false,
        },
  });

export const getAllModelsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  type: true,
  nsfw: true,
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
});

export const getAllModelsOrderBy = ({
  period = MetricTimeframe.AllTime,
}: z.infer<typeof getAllModelsSchema>) =>
  Prisma.validator<Prisma.Enumerable<Prisma.ModelOrderByWithRelationInput>>()([
    {
      rank: {
        [`rating${period}`]: 'desc',
      },
    } as never,
    {
      rank: {
        [`downloadCount${period}`]: 'desc',
      },
    } as never,
    {
      createdAt: 'desc',
    },
  ]);

const modelList = Prisma.validator<Prisma.ModelArgs>()({
  select: getAllModelsSelect,
});

type ModelListProps = Prisma.ModelGetPayload<typeof modelList>;

export type GetAllModelsReturnType = ReturnType<typeof getAllModelsTransform>;

export const getAllModelsTransform = (items: ModelListProps[]) =>
  items.map(({ rank, modelVersions, ...item }) => {
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
