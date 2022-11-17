import { Prisma } from '@prisma/client';
import { imageSelect } from '~/server/selectors/image.selector';

export const getAllModelsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  type: true,
  nsfw: true,
  status: true,
  modelVersions: {
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 1,
    select: {
      images: {
        orderBy: {
          index: 'asc',
        },
        take: 1,
        select: {
          image: {
            select: imageSelect,
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
      downloadCountAllTimeRank: true,
      ratingCountAllTimeRank: true,
      ratingAllTimeRank: true,
    },
  },
});

export const modelWithDetailsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  description: true,
  nsfw: true,
  type: true,
  updatedAt: true,
  status: true,
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
  rank: {
    select: {
      downloadCountAllTime: true,
      ratingCountAllTime: true,
      ratingAllTime: true,
    },
  },
  tagsOnModels: { select: { tag: true } },
});
