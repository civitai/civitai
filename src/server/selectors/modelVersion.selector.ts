import { Prisma } from '@prisma/client';

import { imageSelectWithoutId } from '~/server/selectors/image.selector';

export const getModelVersionDetailsSelect = Prisma.validator<Prisma.ModelVersionSelect>()({
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
  trainedWords: true,
  baseModel: true,
  images: {
    orderBy: {
      index: 'asc',
    },
    select: {
      image: {
        select: imageSelectWithoutId,
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
      format: true,
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
