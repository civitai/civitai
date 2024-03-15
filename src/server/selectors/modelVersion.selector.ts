import { Prisma } from '@prisma/client';
import { modelFileSelect } from './modelFile.selector';
import { modelHashSelect } from './modelHash.selector';
import { ModelFileType } from '../common/constants';

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
  earlyAccessTimeFrame: true,
  description: true,
  vaeId: true,
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
  earlyAccessTimeFrame: true,
  createdAt: true,
  generationCoverage: { select: { covered: true } },
  trainedWords: true,
  baseModel: true,
  baseModelType: true,
  settings: true,
  files: { select: { metadata: true }, where: { type: 'Model' } },
  hashes: {
    select: modelHashSelect,
    where: {
      fileType: { in: ['Model', 'Pruned Model'] as ModelFileType[] },
    },
  },
});
