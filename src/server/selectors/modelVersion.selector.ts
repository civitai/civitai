import { Prisma } from '@prisma/client';

import { imageSelectWithoutName } from '~/server/selectors/image.selector';
import { editPostSelect } from '~/server/selectors/post.selector';

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
  images: {
    orderBy: {
      index: 'asc',
    },
    select: {
      image: {
        select: imageSelectWithoutName,
      },
    },
    take: 20,
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
  posts: {
    select: editPostSelect,
  },
});

export const getModelVersionApiSelect = Prisma.validator<Prisma.ModelVersionSelect>()({
  ...getModelVersionDetailsSelect,
  model: {
    select: { name: true, type: true, nsfw: true, poi: true },
  },
});
const modelVersionApi = Prisma.validator<Prisma.ModelVersionArgs>()({
  select: getModelVersionApiSelect,
});
export type ModelVersionApiReturn = Prisma.ModelVersionGetPayload<typeof modelVersionApi>;
