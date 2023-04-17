import { Prisma } from '@prisma/client';

export const getModelVersionDetailsSelect = Prisma.validator<Prisma.ModelVersionSelect>()({
  id: true,
  modelId: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  trainedWords: true,
  baseModel: true,
  earlyAccessTimeFrame: true,
  description: true,
  rank: {
    select: {
      downloadCountAllTime: true,
      ratingCountAllTime: true,
      ratingAllTime: true,
    },
  },
  files: {
    select: {
      name: true,
      id: true,
      sizeKB: true,
      type: true,
      metadata: true,
      pickleScanResult: true,
      pickleScanMessage: true,
      virusScanResult: true,
      scannedAt: true,
      hashes: {
        select: {
          type: true,
          hash: true,
        },
      },
    },
  },
});

export const getModelVersionApiSelect = Prisma.validator<Prisma.ModelVersionSelect>()({
  ...getModelVersionDetailsSelect,
  model: {
    select: { name: true, type: true, nsfw: true, poi: true, mode: true },
  },
});
const modelVersionApi = Prisma.validator<Prisma.ModelVersionArgs>()({
  select: getModelVersionApiSelect,
});
export type ModelVersionApiReturn = Prisma.ModelVersionGetPayload<typeof modelVersionApi>;
