import { MetricTimeframe, Prisma } from '@prisma/client';
import { imageDetailsSelect, imageSimpleSelect } from '~/server/validators/image/selectors';

export const modelWithDetailsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  description: true,
  trainedWords: true,
  nsfw: true,
  type: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      username: true,
    },
  },
  modelVersions: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: {
      id: true,
      name: true,
      description: true,
      steps: true,
      epochs: true,
      trainingDataUrl: true,
      url: true,
      sizeKB: true,
      createdAt: true,
      updatedAt: true,
      images: {
        orderBy: {
          index: 'asc',
        },
        select: {
          index: true,
          image: {
            select: imageDetailsSelect,
          },
        },
      },
      metrics: {
        select: {
          rating: true,
          ratingCount: true,
          downloadCount: true,
          timeframe: true,
        },
        where: {
          timeframe: MetricTimeframe.AllTime,
        },
      },
    },
  },
  reviews: {
    select: {
      text: true,
      rating: true,
      user: true,
      nsfw: true,
      createdAt: true,
      modelVersion: { select: { id: true, name: true } },
      imagesOnReviews: { select: { image: { select: imageSimpleSelect } } },
    },
  },
  metrics: {
    select: {
      rating: true,
      ratingCount: true,
      downloadCount: true,
      timeframe: true,
    },
    where: {
      timeframe: MetricTimeframe.AllTime,
    },
  },
  tagsOnModels: { select: { tag: true } },
});

const modelWithDetails = Prisma.validator<Prisma.ModelArgs>()({
  select: modelWithDetailsSelect,
});

export type ModelWithDetails = Prisma.ModelGetPayload<typeof modelWithDetails>;
