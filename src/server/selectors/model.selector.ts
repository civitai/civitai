import { ModelHashType, Prisma } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import { modelHashSelect } from '~/server/selectors/modelHash.selector';
import { getModelVersionDetailsSelect } from '~/server/selectors/modelVersion.selector';
import { simpleUserSelect } from '~/server/selectors/user.selector';
import { modelFileSelect } from './modelFile.selector';

export const getAllModelsWithVersionsSelect = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  description: true,
  type: true,
  // TODO [bw]: do we need uploadType here?
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
      tippedAmountCountAllTimeRank: true,
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
      rank: {
        select: {
          downloadCountAllTime: true,
          ratingCountAllTime: true,
          ratingAllTime: true,
        },
      },
      files: {
        select: modelFileSelect,
      },
      generationCoverage: { select: { covered: true } },
    },
  },
  rank: {
    select: {
      downloadCountAllTime: true,
      ratingCountAllTime: true,
      ratingAllTime: true,
      favoriteCountAllTime: true,
      imageCountAllTime: true,
      collectedCountAllTime: true,
    },
  },
  tagsOnModels: { select: { tag: { select: { id: true, name: true } } } },
});

export const modelForHomePageSelector = Prisma.validator<Prisma.ModelSelect>()({
  id: true,
  name: true,
  type: true,
  nsfw: true,
  status: true,
  createdAt: true,
  lastVersionAt: true,
  publishedAt: true,
  locked: true,
  earlyAccessDeadline: true,
  mode: true,
  rank: {
    select: {
      downloadCountAllTime: true,
      favoriteCountAllTime: true,
      commentCountAllTime: true,
      ratingCountAllTime: true,
      ratingAllTime: true,
    },
  },
  modelVersions: {
    orderBy: { index: 'asc' },
    take: 1,
    select: {
      id: true,
      earlyAccessTimeFrame: true,
      createdAt: true,
      generationCoverage: { select: { covered: true } },
    },
  },
  user: { select: simpleUserSelect },
  hashes: {
    select: modelHashSelect,
    where: {
      hashType: ModelHashType.SHA256,
      fileType: { in: ['Model', 'Pruned Model'] as ModelFileType[] },
    },
  },
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
