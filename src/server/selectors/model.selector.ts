import { Prisma } from '@prisma/client';
import {
  getModelVersionDetailsSelect,
  getModelVersionsForSearchIndex,
} from '~/server/selectors/modelVersion.selector';
import { simpleUserSelect, userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import type { ModelHashType } from '~/shared/utils/prisma/enums';
import { Availability, MetricTimeframe, ModelStatus } from '~/shared/utils/prisma/enums';
import type { ModelFileType } from '../common/constants';
import { profileImageSelect } from './image.selector';
import { modelFileSelect } from './modelFile.selector';
import { modelHashSelect } from './modelHash.selector';

export const getAllModelsWithVersionsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  description: true,
  type: true,
  uploadType: true,
  poi: true,
  nsfwLevel: true,
  allowNoCredit: true,
  allowCommercialUse: true,
  allowDerivatives: true,
  allowDifferentLicense: true,
  mode: true,
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
});

export const modelWithDetailsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  description: true,
  poi: true,
  minor: true,
  sfwOnly: true,
  nsfwLevel: true,
  nsfw: true,
  type: true,
  uploadType: true,
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
  availability: true,
  lockedProperties: true,
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
      profilePicture: {
        select: profileImageSelect,
      },
      cosmetics: {
        where: { equippedAt: { not: null } },
        select: {
          data: true,
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
      trainingStatus: true,
      trainingDetails: true,
      inaccurate: true,
      baseModel: true,
      baseModelType: true,
      earlyAccessEndsAt: true,
      earlyAccessConfig: true,
      status: true,
      publishedAt: true,
      meta: true,
      vaeId: true,
      settings: true,
      requireAuth: true,
      nsfwLevel: true,
      uploadType: true,
      usageControl: true,
      metrics: {
        select: {
          generationCount: true,
          downloadCount: true,
          thumbsUpCount: true,
          thumbsDownCount: true,
          earnedAmount: true,
        },
      },
      files: {
        select: modelFileSelect,
        where: { dataPurged: false },
      },
      generationCoverage: { select: { covered: true } },
      recommendedResources: {
        select: {
          id: true,
          resource: {
            select: {
              id: true,
              // name: true,
              // baseModel: true,
              // trainedWords: true,
              // model: { select: { id: true, name: true, type: true } },
            },
          },
          settings: true,
        },
      },
    },
  },
  metrics: {
    select: {
      downloadCount: true,
      thumbsUpCount: true,
      thumbsDownCount: true,
      imageCount: true,
      collectedCount: true,
      tippedAmountCount: true,
      generationCount: true,
      commentCount: true,
    },
  },
});

export const associatedResourceSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  type: true,
  nsfwLevel: true,
  user: { select: simpleUserSelect },
});
const associatedResource = Prisma.validator<Prisma.ModelFindManyArgs>()({
  select: associatedResourceSelect,
});
export type AssociatedResourceModel = Prisma.ModelGetPayload<typeof associatedResource>;

export const modelSearchIndexSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  type: true,
  nsfw: true,
  nsfwLevel: true,
  meta: true,
  minor: true,
  sfwOnly: true,
  status: true,
  createdAt: true,
  lastVersionAt: true,
  publishedAt: true,
  locked: true,
  earlyAccessDeadline: true,
  mode: true,
  checkpointType: true,
  availability: true,
  allowNoCredit: true,
  allowCommercialUse: true,
  allowDerivatives: true,
  allowDifferentLicense: true,
  poi: true,
  // Joins:
  user: {
    select: userWithCosmeticsSelect,
  },
  modelVersions: {
    select: getModelVersionsForSearchIndex,
    orderBy: { index: 'asc' as const },
    where: {
      status: ModelStatus.Published,
      availability: {
        not: Availability.Unsearchable,
      },
    },
  },
  hashes: {
    select: modelHashSelect,
    where: {
      fileType: { in: ['Model', 'Pruned Model'] as ModelFileType[] },
      hashType: { notIn: ['AutoV1'] as ModelHashType[] },
    },
  },
  metrics: {
    select: {
      commentCount: true,
      thumbsUpCount: true,
      downloadCount: true,
      collectedCount: true,
      tippedAmountCount: true,
    },
  },
});
