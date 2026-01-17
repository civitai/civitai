import { startCase } from 'lodash-es';
import type { ModelFileType } from '~/server/common/constants';
import { canGenerateWithEpoch } from '~/server/common/model-helpers';
import { ModelType } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';

type FileFormatType = {
  // eslint-disable-next-line @typescript-eslint/ban-types
  type: ModelFileType | (string & {});
  metadata: BasicFileMetadata;
};

export const defaultFilePreferences: Omit<FileFormatType, 'type'> = {
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16', quantType: 'Q4_K_M' },
};

type FileMetaKey = keyof BasicFileMetadata;
const preferenceWeight: Partial<Record<FileMetaKey, number>> = {
  format: 100,
  size: 10,
  fp: 1,
  quantType: 0.5,
};

export function getPrimaryFile<T extends FileFormatType>(
  files: Array<T>,
  preferences: Partial<FileFormatType> = defaultFilePreferences
) {
  if (!files.length) return null;

  const preferredMetadata = { ...defaultFilePreferences.metadata, ...preferences.metadata };

  const getScore = (file: FileFormatType) => {
    let score = 1000;
    for (const [key, value] of Object.entries(file.metadata ?? {})) {
      const weight = preferenceWeight[key as FileMetaKey];
      if (!weight) continue;
      if (value === preferredMetadata[key as FileMetaKey]) score += weight;
      else score -= weight;
    }

    // Give priority to model files
    if (file.type === 'Model' || file.type === 'Pruned Model') score += 1000;

    return score;
  };

  return files
    .map((file) => ({
      file,
      score: getScore(file),
    }))
    .sort((a, b) => b.score - a.score)[0]?.file;
}

export const getFileDisplayName = ({
  file,
  modelType,
}: {
  file: { type: string | ModelFileType; metadata: FileMetadata };
  modelType: ModelType;
}) => {
  const { format, size, fp } = file.metadata;
  if (file.type === 'Model') {
    if (modelType === ModelType.Checkpoint)
      return `${startCase(size)} ${startCase(file.type)} ${fp ?? ''}`;
    return getDisplayName(modelType);
  }
  return startCase(file.type);
};

export const getEpochJobAndFileName = (downloadUrl: string) => {
  let jobFileUrl; // Leaves you with: ${jobId}/assets/${fileName}
  let jobId;
  let fileName;

  if (downloadUrl.includes('/jobs/')) {
    jobFileUrl = downloadUrl.split('/jobs/')[1]; // Leaves you with: ${jobId}/assets/${fileName}
    jobId = jobFileUrl.split('/assets/')[0];
    fileName = jobFileUrl.split('/assets/')[1];
  } else if (downloadUrl.includes('/consumer/blobs')) {
    jobId = 'blob';
    fileName = downloadUrl.split('/consumer/blobs/')[1].split('?')[0];
  } else {
    console.warn('Download URL does not contain expected /jobs/ path:', downloadUrl);
    return null;
  }

  if (!jobId || !fileName) {
    throw new Error('Could not get jobId or fileName');
  }

  return { jobId, fileName };
};

export const getTrainingFileEpochNumberDetails = (
  file: { type: string | ModelFileType; metadata: FileMetadata },
  epochNumber?: number
) => {
  console.log('getTrainingFileEpochNumberDetails');
  const epoch =
    file.metadata.trainingResults?.epochs?.find((e) =>
      'epoch_number' in e ? e.epoch_number === epochNumber : e.epochNumber === epochNumber
    ) ?? file.metadata.trainingResults?.epochs?.pop();

  if (!epoch) return null;

  const downloadUrl = 'epoch_number' in epoch ? epoch.model_url : epoch.modelUrl;
  const { jobId, fileName } = getEpochJobAndFileName(downloadUrl)!;
  const completeDate =
    file.metadata.trainingResults?.version === 2
      ? file.metadata.trainingResults.completedAt
      : file.metadata.trainingResults?.end_time;

  return {
    jobId,
    fileName,
    epochNumber: epochNumber ?? ('epoch_number' in epoch ? epoch.epoch_number : epoch.epochNumber),
    isExpired: !canGenerateWithEpoch(completeDate),
  };
};

/**
 * Groups model files by variant for sidebar display.
 * - Model files are grouped by format (SafeTensor, GGUF, etc.)
 * - Component files are grouped by component type (VAE, TextEncoder, etc.)
 * - Within each group, files are sorted by quality (best first)
 */
export type GroupedFileVariants<T> = {
  safeTensorVariants: T[];
  ggufVariants: T[];
  otherFormatVariants: T[];
  components: Partial<Record<ModelFileComponentType, T[]>>;
};

// Quality ranking for fp (higher index = better quality)
const fpQualityRank: Record<ModelFileFp, number> = {
  nf4: 1,
  fp8: 2,
  bf16: 3,
  fp16: 4,
  fp32: 5,
};

// Quality ranking for quant types (higher index = better quality)
const quantQualityRank: Record<ModelFileQuantType, number> = {
  Q2_K: 1,
  Q3_K_M: 2,
  Q4_K_S: 3,
  Q4_K_M: 4,
  Q5_K_M: 5,
  Q6_K: 6,
  Q8_0: 7,
};

// Model file types (as opposed to component types)
const modelFileTypes = ['Model', 'Pruned Model'] as const;

// Component file types
const componentFileTypes = ['VAE', 'Text Encoder', 'Config', 'Archive'] as const;

/**
 * Sorts files by quality (best quality first).
 * For SafeTensor files: fp32 > fp16 > bf16 > fp8 > nf4
 * For GGUF files: Q8_0 > Q6_K > Q5_K_M > Q4_K_M > Q4_K_S > Q3_K_M > Q2_K
 * Full size > pruned size
 */
function sortByQuality<T extends FileFormatType>(files: T[]): T[] {
  return [...files].sort((a, b) => {
    const metaA = a.metadata ?? {};
    const metaB = b.metadata ?? {};

    // For GGUF files, sort by quant type
    if (metaA.format === 'GGUF' && metaB.format === 'GGUF') {
      const quantA = metaA.quantType ? quantQualityRank[metaA.quantType] ?? 0 : 0;
      const quantB = metaB.quantType ? quantQualityRank[metaB.quantType] ?? 0 : 0;
      if (quantA !== quantB) return quantB - quantA;
    }

    // Sort by fp precision
    const fpA = metaA.fp ? fpQualityRank[metaA.fp] ?? 0 : 0;
    const fpB = metaB.fp ? fpQualityRank[metaB.fp] ?? 0 : 0;
    if (fpA !== fpB) return fpB - fpA;

    // Sort by size (full > pruned)
    const sizeA = metaA.size === 'full' ? 1 : 0;
    const sizeB = metaB.size === 'full' ? 1 : 0;
    return sizeB - sizeA;
  });
}

/**
 * Groups files by variant for display in the model sidebar.
 *
 * @param files - Array of model files to group
 * @returns Grouped files by format and component type
 */
export function groupFilesByVariant<T extends FileFormatType>(files: T[]): GroupedFileVariants<T> {
  const result: GroupedFileVariants<T> = {
    safeTensorVariants: [],
    ggufVariants: [],
    otherFormatVariants: [],
    components: {},
  };

  if (!files || files.length === 0) {
    return result;
  }

  for (const file of files) {
    const fileType = file.type;
    const metadata = file.metadata ?? {};
    const format = metadata.format;

    // Check if this is a model file type
    const isModelFile = modelFileTypes.includes(fileType as (typeof modelFileTypes)[number]);

    if (isModelFile) {
      // Group model files by format
      if (format === 'SafeTensor') {
        result.safeTensorVariants.push(file);
      } else if (format === 'GGUF') {
        result.ggufVariants.push(file);
      } else {
        // Other formats (PickleTensor, Diffusers, Core ML, ONNX, Other)
        result.otherFormatVariants.push(file);
      }
    } else {
      // Group component files by component type
      const componentType = metadata.componentType ?? inferComponentType(fileType);
      if (componentType) {
        if (!result.components[componentType]) {
          result.components[componentType] = [];
        }
        result.components[componentType]!.push(file);
      }
    }
  }

  // Sort each group by quality
  result.safeTensorVariants = sortByQuality(result.safeTensorVariants);
  result.ggufVariants = sortByQuality(result.ggufVariants);
  result.otherFormatVariants = sortByQuality(result.otherFormatVariants);

  // Sort component groups by quality
  for (const key of Object.keys(result.components) as ModelFileComponentType[]) {
    result.components[key] = sortByQuality(result.components[key]!);
  }

  return result;
}

/**
 * Infers component type from file type if not explicitly set in metadata.
 */
function inferComponentType(fileType: string): ModelFileComponentType | null {
  switch (fileType) {
    case 'VAE':
      return 'VAE';
    case 'Text Encoder':
      return 'TextEncoder';
    case 'Config':
      return 'Config';
    default:
      return null;
  }
}
