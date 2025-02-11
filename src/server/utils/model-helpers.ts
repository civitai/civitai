import { startCase } from 'lodash-es';
import { ModelFileType } from '~/server/common/constants';
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
    for (const [key, value] of Object.entries(file.metadata)) {
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

export const getTrainingFileEpochNumberDetails = (
  file: { type: string | ModelFileType; metadata: FileMetadata },
  epochNumber?: number
) => {
  const epoch =
    file.metadata.trainingResults?.epochs?.find((e) =>
      'epoch_number' in e ? e.epoch_number === epochNumber : e.epochNumber === epochNumber
    ) ?? file.metadata.trainingResults?.epochs?.pop();

  if (!epoch) return null;

  const downloadUrl = 'epoch_number' in epoch ? epoch.model_url : epoch.modelUrl;
  const jobFileUrl = downloadUrl.split('/jobs/')[1]; // Leaves you with: ${jobId}/assets/${fileName}
  const jobId = jobFileUrl.split('/assets/')[0];
  const fileName = jobFileUrl.split('/assets/')[1];

  return {
    jobId,
    fileName,
    epochNumber: epochNumber ?? ('epoch_number' in epoch ? epoch.epoch_number : epoch.epochNumber),
  };
};
