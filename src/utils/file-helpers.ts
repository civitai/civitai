import { Prisma, ScanResultCode } from '@prisma/client';
import { ModelFileInput } from '~/server/schema/model-file.schema';

export function getModelFileFormat(filename: string): ModelFileFormat {
  if (filename.endsWith('.safetensors') || filename.endsWith('.sft')) return 'SafeTensor';
  else if (filename.endsWith('.pt') || filename.endsWith('.ckpt')) return 'PickleTensor';
  else if (filename.endsWith('.zip')) return 'Diffusers';

  return 'Other';
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
  let format: ModelFileFormat = 'Other';
  if (file.type === 'Model') {
    const includeFileFormat = file.name.endsWith('.zip');
    if (includeFileFormat && file.metadata?.format) format = file.metadata.format;
    else format = getModelFileFormat(file.name);
  }

  return {
    ...file,
    ...(file.id ? {} : unscannedFile), // Only set unscannedFile on new files
    metadata: {
      ...file.metadata,
      format,
    },
  };
}
