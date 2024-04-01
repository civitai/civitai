import { Prisma } from '@prisma/client';
import { getModelVersionDetailsSelect } from '~/server/selectors/modelVersion.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { modelFileSelect } from './modelFile.selector';
import { profileImageSelect } from './image.selector';

export const getAllModelsWithVersionsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  description: true,
  type: true,
  // TODO [bw]: do we need uploadType here?
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
      earlyAccessTimeFrame: true,
      status: true,
      publishedAt: true,
      meta: true,
      vaeId: true,
      settings: true,
      requireAuth: true,
      nsfwLevel: true,
      metrics: {
        where: { timeframe: 'AllTime' },
        select: {
          generationCount: true,
          downloadCount: true,
          ratingCount: true,
          rating: true,
          thumbsUpCount: true,
          thumbsDownCount: true,
        },
      },
      files: {
        select: modelFileSelect,
      },
      generationCoverage: { select: { covered: true } },
      recommendedResources: {
        select: {
          id: true,
          resource: {
            select: {
              id: true,
              name: true,
              baseModel: true,
              trainedWords: true,
              model: { select: { id: true, name: true, type: true } },
            },
          },
          settings: true,
        },
      },
    },
  },
  metrics: {
    where: { timeframe: 'AllTime' },
    select: {
      downloadCount: true,
      ratingCount: true,
      rating: true,
      favoriteCount: true,
      thumbsUpCount: true,
      thumbsDownCount: true,
      imageCount: true,
      collectedCount: true,
      tippedAmountCount: true,
      generationCount: true,
      commentCount: true,
    },
  },
  tagsOnModels: {
    select: {
      tag: {
        select: { id: true, name: true, unlisted: true },
      },
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
const associatedResource = Prisma.validator<Prisma.ModelArgs>()({
  select: associatedResourceSelect,
});
export type AssociatedResourceModel = Prisma.ModelGetPayload<typeof associatedResource>;
