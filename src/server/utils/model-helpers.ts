import { ModelType } from '@prisma/client';
import { startCase } from 'lodash-es';
import { ModelFileType } from '~/server/common/constants';
import { getDisplayName } from '~/utils/string-helpers';

type FileFormatType = {
  type: string | ModelFileType;
  metadata: FileMetadata;
};

export const defaultFilePreferences: Omit<FileFormatType, 'type'> = {
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
};

type FileMetaKey = keyof FileMetadata;
const preferenceWeight: Record<FileMetaKey, number> = {
  format: 1000,
  size: 100,
  fp: 10,
};

export function getPrimaryFile<T extends FileFormatType>(
  files: Array<T>,
  preferences: Partial<FileFormatType> = defaultFilePreferences
) {
  if (!files.length) return null;

  const preferredMetadata = { ...defaultFilePreferences.metadata, ...preferences.metadata };

  const getScore = (file: FileFormatType) => {
    let score = 0;
    for (const [key, value] of Object.entries(file.metadata)) {
      const weight = preferenceWeight[key as FileMetaKey];
      if (value === preferredMetadata[key as FileMetaKey]) score += weight;
      else if (value === defaultFilePreferences.metadata[key as FileMetaKey]) score -= weight;
    }
    return score;
  };

  return files
    .map((file) => ({
      file,
      score: getScore(file),
    }))
    .sort((a, b) => b.score - a.score)[0].file;
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
      return `${startCase(size)} ${startCase(file.type)} ${fp}`;
    return getDisplayName(modelType);
  }
  return startCase(file.type);
};
