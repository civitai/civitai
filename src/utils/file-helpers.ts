import { Prisma, ScanResultCode } from '@prisma/client';
import { ModelFileInput } from '~/server/schema/model-file.schema';

export function getModelFileFormat(filename: string): ModelFileFormat {
  if (filename.endsWith('.safetensors')) return 'SafeTensor';
  else if (filename.endsWith('.pt') || filename.endsWith('.ckpt')) return 'PickleTensor';

  return 'Other';
}

const unscannedFile = {
  scannedAt: null,
  scanRequestedAt: null,
  rawScanResult: Prisma.JsonNull,
  virusScanMessage: null,
  virusScanResult: ScanResultCode.Success,
  pickleScanMessage: null,
  pickleScanResult: ScanResultCode.Success,
};

export function prepareFile(file: ModelFileInput) {
  return {
    ...file,
    ...(file.id ? {} : unscannedFile), // Only set unscannedFile on new files
    metadata: {
      ...file.metadata,
      format: file.type === 'Model' ? getModelFileFormat(file.name) : 'Other',
    },
  };
}
