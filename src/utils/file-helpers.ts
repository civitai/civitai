import { ScanResultCode } from '~/shared/utils/prisma/enums';
import type { ModelFileInput } from '~/server/schema/model-file.schema';

export function getModelFileFormat(filename: string): ModelFileFormat {
  if (filename.endsWith('.safetensors') || filename.endsWith('.sft')) return 'SafeTensor';
  else if (filename.endsWith('.gguf')) return 'GGUF';
  else if (filename.endsWith('.pt') || filename.endsWith('.ckpt')) return 'PickleTensor';
  else if (filename.endsWith('.zip')) return 'Other';

  return 'Other';
}

const unscannedFile = {
  scannedAt: null,
  scanRequestedAt: null,
  rawScanResult: null,
  virusScanMessage: null,
  virusScanResult: ScanResultCode.Pending,
  pickleScanMessage: null,
  pickleScanResult: ScanResultCode.Pending,
};

export function prepareFile(file: ModelFileInput) {
  // .zip files can contain formats that aren't inferable from the extension (e.g. Diffusers),
  // so trust an explicit metadata.format for those. Otherwise infer from the filename — for
  // every file type, not only `Model` (multi-file packs use VAE / Text Encoder / Diffusion Model).
  const providedFormat = file.name.endsWith('.zip') ? file.metadata?.format : undefined;
  const format: ModelFileFormat = providedFormat ?? getModelFileFormat(file.name);

  return {
    ...file,
    ...(file.id ? {} : unscannedFile), // Only set unscannedFile on new files
    metadata: {
      ...file.metadata,
      format,
    },
  };
}
