import { Prisma } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import { ModelFileMetadata } from '~/shared/types/model-file.types';

export const modelFileSelect = Prisma.validator<Prisma.ModelFileSelect>()({
  id: true,
  url: true,
  sizeKB: true,
  name: true,
  type: true,
  visibility: true,
  metadata: true,
  pickleScanResult: true,
  pickleScanMessage: true,
  virusScanResult: true,
  virusScanMessage: true,
  scannedAt: true,
  modelVersionId: true,
  hashes: {
    select: {
      type: true,
      hash: true,
    },
  },
});
const modelFile = Prisma.validator<Prisma.ModelFileDefaultArgs>()({
  select: modelFileSelect,
});
export type ModelFileModel = Omit<
  Prisma.ModelFileGetPayload<typeof modelFile>,
  'metadata' | 'type'
> & {
  metadata: ModelFileMetadata;
  type: ModelFileType;
};
