import { ModelType } from '@prisma/client';
import { startCase } from 'lodash';
import { ModelFileType } from '~/server/common/constants';
import { getDisplayName } from '~/utils/string-helpers';

type FileFormatType = {
  type: string | ModelFileType;
  metadata: FileMetadata;
};

export const defaultFilePreferences: Omit<FileFormatType, 'type'> = {
  metadata: { format: 'SafeTensor', size: 'pruned', fp: 'fp16' },
};

export function getPrimaryFile<T extends FileFormatType>(
  files: Array<T>,
  preferences: Partial<FileFormatType> = defaultFilePreferences
) {
  if (!files.length) return null;

  const {
    metadata: { format: preferredFormat, fp: preferredFp, size: preferredSize } = {
      ...defaultFilePreferences.metadata,
    },
  } = preferences;

  const defaultMetadata = defaultFilePreferences.metadata;

  const getScore = (file: FileFormatType) => {
    const { format, size, fp } = file.metadata;
    let score = 0;

    score += format === preferredFormat ? 1000 : format === defaultMetadata.format ? -1000 : 0;
    score += size === preferredSize ? 100 : size === defaultMetadata.size ? -100 : 0;
    score += fp === preferredFp ? 10 : fp === defaultMetadata.fp ? -10 : 0;

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
