import { ModelFileFormat, Prisma, ScanResultCode } from '@prisma/client';
import { ModelFileInput } from '~/server/schema/model-file.schema';

export function getModelFileFormat(filename: string) {
  if (filename.endsWith('.safetensors')) return ModelFileFormat.SafeTensor;
  else if (filename.endsWith('.pt') || filename.endsWith('.ckpt'))
    return ModelFileFormat.PickleTensor;

  return ModelFileFormat.Other;
}

const unscannedFile = {
  scannedAt: null,
  scanRequestedAt: null,
  rawScanResult: Prisma.JsonNull,
  virusScanMessage: null,
  virusScanResult: ScanResultCode.Pending,
  pickleScanMessage: null,
  pickleScanResult: ScanResultCode.Pending,
};

export function prepareFile(file: ModelFileInput) {
  return {
    ...file,
    ...(file.id ? {} : unscannedFile), // Only set unscannedFile on new files
    format:
      file.type === 'Model' || file.type === 'Pruned Model'
        ? getModelFileFormat(file.name)
        : ModelFileFormat.Other,
  };
}
