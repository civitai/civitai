import { Prisma } from '@prisma/client';
import { ModelHashType } from '~/shared/utils/prisma/enums';
import { ModelFileType } from '../common/constants';
import { modelFileSelect } from './modelFile.selector';
import { modelHashSelect } from './modelHash.selector';

export const getModelVersionDetailsSelect = Prisma.validator<Prisma.ModelVersionSelect>()({
  id: true,
  modelId: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  status: true,
  publishedAt: true,
  trainedWords: true,
  trainingStatus: true,
  trainingDetails: true,
  baseModel: true,
  baseModelType: true,
  earlyAccessEndsAt: true,
  earlyAccessConfig: true,
  description: true,
  vaeId: true,
  uploadType: true,
  usageControl: true,
  metrics: {
    where: { timeframe: 'AllTime' },
    select: {
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
});

export const getModelVersionApiSelect = Prisma.validator<Prisma.ModelVersionSelect>()({
  ...getModelVersionDetailsSelect,
  model: {
    select: { name: true, type: true, nsfw: true, poi: true, mode: true },
  },
});
const modelVersionApi = Prisma.validator<Prisma.ModelVersionDefaultArgs>()({
  select: getModelVersionApiSelect,
});
export type ModelVersionApiReturn = Prisma.ModelVersionGetPayload<typeof modelVersionApi>;

export const getModelVersionsForSearchIndex = Prisma.validator<Prisma.ModelVersionSelect>()({
  id: true,
  name: true,
  earlyAccessEndsAt: true,
  createdAt: true,
  generationCoverage: { select: { covered: true } },
  trainedWords: true,
  baseModel: true,
  baseModelType: true,
  settings: true,
  steps: true,
  epochs: true,
  clipSkip: true,
  files: { select: { metadata: true }, where: { type: 'Model' } },
  hashes: {
    select: {
      ...modelHashSelect,
      hashType: true,
    },
    where: {
      fileType: { in: ['Model', 'Pruned Model'] as ModelFileType[] },
      hashType: { notIn: ['AutoV1'] as ModelHashType[] },
    },
  },
  metrics: {
    where: { timeframe: 'AllTime' },
    select: {
      downloadCount: true,
      ratingCount: true,
      rating: true,
      thumbsUpCount: true,
      thumbsDownCount: true,
      generationCount: true,
    },
  },
});
