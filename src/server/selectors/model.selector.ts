import { Prisma } from '@prisma/client';
import { SessionUser } from 'next-auth';
import { imageSelect } from '~/server/selectors/image.selector';
import { getModelVersionDetailsSelect } from '~/server/selectors/modelVersion.selector';

export const getAllModelsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  type: true,
  nsfw: true,
  status: true,
  allowNoCredit: true,
  allowCommercialUse: true,
  allowDerivatives: true,
  allowDifferentLicense: true,
  licenses: true,
  modelVersions: {
    orderBy: { index: 'asc' },
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
      downloadCountDay: true,
      downloadCountWeek: true,
      downloadCountMonth: true,
      downloadCountYear: true,
      downloadCountAllTime: true,
      commentCountDay: true,
      commentCountWeek: true,
      commentCountMonth: true,
      commentCountYear: true,
      commentCountAllTime: true,
      favoriteCountDay: true,
      favoriteCountWeek: true,
      favoriteCountMonth: true,
      favoriteCountYear: true,
      favoriteCountAllTime: true,
      ratingCountDay: true,
      ratingCountWeek: true,
      ratingCountMonth: true,
      ratingCountYear: true,
      ratingCountAllTime: true,
      ratingDay: true,
      ratingWeek: true,
      ratingMonth: true,
      ratingYear: true,
      ratingAllTime: true,
      downloadCountAllTimeRank: true,
      favoriteCountAllTimeRank: true,
      commentCountAllTimeRank: true,
      ratingCountAllTimeRank: true,
      ratingAllTimeRank: true,
    },
  },
});

export const getAllModelsWithVersionsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  description: true,
  type: true,
  poi: true,
  nsfw: true,
  allowNoCredit: true,
  allowCommercialUse: true,
  allowDerivatives: true,
  allowDifferentLicense: true,
  rank: {
    select: {
      downloadCountAllTime: true,
      commentCountAllTime: true,
      favoriteCountAllTime: true,
      ratingCountAllTime: true,
      ratingAllTime: true,
    },
  },
  user: {
    select: {
      image: true,
      username: true,
    },
  },
  modelVersions: {
    select: getModelVersionDetailsSelect,
    orderBy: { index: 'asc' },
  },
  tagsOnModels: {
    select: {
      tag: {
        select: { name: true },
      },
    },
  },
});

export const modelWithDetailsSelect = (includeNSFW = true, user?: SessionUser) =>
  Prisma.validator<Prisma.ModelSelect>()({
    id: true,
    name: true,
    description: true,
    poi: true,
    nsfw: true,
    type: true,
    updatedAt: true,
    deletedAt: true,
    status: true,
    checkpointType: true,
    allowNoCredit: true,
    allowCommercialUse: true,
    allowDerivatives: true,
    allowDifferentLicense: true,
    licenses: true,
    publishedAt: true,
    locked: true,
    reportStats: {
      select: {
        ownershipProcessing: true,
      },
    },
    user: {
      select: {
        id: true,
        image: true,
        username: true,
        deletedAt: true,
        rank: { select: { leaderboardRank: true } },
        cosmetics: {
          where: { equippedAt: { not: null } },
          select: {
            cosmetic: {
              select: {
                id: true,
                data: true,
                type: true,
                source: true,
                name: true,
              },
            },
          },
        },
      },
    },
    // TODO - why is this not referencing `getModelVersionDetailsSelect`? If they are out of sync, we should sync it up
    modelVersions: {
      orderBy: { index: 'asc' },
      select: {
        id: true,
        modelId: true,
        name: true,
        description: true,
        steps: true,
        epochs: true,
        createdAt: true,
        updatedAt: true,
        trainedWords: true,
        inaccurate: true,
        baseModel: true,
        earlyAccessTimeFrame: true,
        images: {
          orderBy: { index: 'asc' },
          select: {
            index: true,
            image: {
              select: imageSelect,
            },
          },
          where: {
            image: {
              nsfw: includeNSFW ? undefined : false,
              tosViolation: false,
              OR: [{ needsReview: false }, { userId: user?.id }],
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
            id: true,
            url: true,
            sizeKB: true,
            name: true,
            type: true,
            format: true,
            pickleScanResult: true,
            pickleScanMessage: true,
            virusScanResult: true,
            virusScanMessage: true,
            scannedAt: true,
            rawScanResult: true,
            hashes: {
              select: {
                type: true,
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
        favoriteCountAllTime: true,
      },
    },
    tagsOnModels: { select: { tag: { select: { id: true, name: true } } } },
  });
