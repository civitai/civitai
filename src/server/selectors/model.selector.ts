import { MetricTimeframe, ModelHashType, Prisma } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import { getModelVersionDetailsSelect } from '~/server/selectors/modelVersion.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';

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
  mode: true,
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

export const modelWithDetailsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  description: true,
  poi: true,
  nsfw: true,
  type: true,
  updatedAt: true,
  deletedAt: true,
  deletedBy: true,
  status: true,
  checkpointType: true,
  allowNoCredit: true,
  allowCommercialUse: true,
  allowDerivatives: true,
  allowDifferentLicense: true,
  licenses: true,
  publishedAt: true,
  locked: true,
  meta: true,
  earlyAccessDeadline: true,
  mode: true,
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
      // TODO.leaderboard: uncomment when migration is done
      // leaderboardShowcase: true,
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
  modelVersions: {
    orderBy: { index: 'asc' },
    select: {
      id: true,
      modelId: true,
      name: true,
      description: true,
      steps: true,
      epochs: true,
      clipSkip: true,
      createdAt: true,
      updatedAt: true,
      trainedWords: true,
      inaccurate: true,
      baseModel: true,
      earlyAccessTimeFrame: true,
      status: true,
      publishedAt: true,
      meta: true,
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
          metadata: true,
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
      modelVersionGenerationCoverage: { select: { workers: true } },
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

export const associatedResourceSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  type: true,
  nsfw: true,
  user: { select: simpleUserSelect },
});
const associatedResource = Prisma.validator<Prisma.ModelArgs>()({
  select: associatedResourceSelect,
});
export type AssociatedResourceModel = Prisma.ModelGetPayload<typeof associatedResource>;
