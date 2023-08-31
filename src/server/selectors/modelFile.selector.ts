import { Prisma } from '@prisma/client';

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
  hashes: {
    select: {
      type: true,
      hash: true,
    },
  },
});
