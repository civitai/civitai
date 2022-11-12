import { Prisma } from '@prisma/client';
import { imageSelect } from '~/server/validators/image/selectors';

export const modelWithDetailsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  description: true,
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
      createdAt: true,
      updatedAt: true,
      trainedWords: true,
      images: {
        orderBy: {
          index: 'asc',
        },
        select: {
          index: true,
          image: {
            select: imageSelect,
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
      files: {
        select: {
          url: true,
          sizeKB: true,
          name: true,
          type: true,
          pickleScanResult: true,
          pickleScanMessage: true,
          virusScanResult: true,
          virusScanMessage: true,
          scannedAt: true,
          rawScanResult: true,
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
      imagesOnReviews: { select: { image: { select: imageSelect } } },
    },
  },
  rank: {
    select: {
      downloadCountAllTime: true,
      ratingCountAllTime: true,
      ratingAllTime: true,
    },
  },
  tagsOnModels: { select: { tag: true } },
});

const modelWithDetails = Prisma.validator<Prisma.ModelArgs>()({
  select: modelWithDetailsSelect,
});

export type ModelWithDetails = Prisma.ModelGetPayload<typeof modelWithDetails>;
