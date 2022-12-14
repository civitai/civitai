import { ModelFileFormat, ModelFileType, Prisma, ScanResultCode } from '@prisma/client';
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
    ...unscannedFile,
    format:
      file.type === ModelFileType.Model || file.type === ModelFileType.PrunedModel
        ? getModelFileFormat(file.name)
        : ModelFileFormat.Other,
  };
}
