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
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
};

type FileMetaKey = keyof BasicFileMetadata;
const preferenceWeight: Record<FileMetaKey, number> = {
  format: 100,
  size: 10,
  fp: 1,
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
