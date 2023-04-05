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

  const getScore = (file: FileFormatType) => {
    const { format, size, fp } = file.metadata;

    if (size === preferredSize && format === preferredFormat && fp === preferredFp) return 5;
    else if (size === preferredSize && format === preferredFormat) return 4;
    else if (format === preferredFormat) return 3;
    else if (size === preferredSize) return 2;
    else if (fp === preferredFp) return 1;
    else if (
      size === defaultFilePreferences.metadata.size &&
      format === defaultFilePreferences.metadata.format &&
      fp === defaultFilePreferences.metadata.fp
    )
      return 0;
    else if (
      size === defaultFilePreferences.metadata.size &&
      format === defaultFilePreferences.metadata.format
    )
      return -1;
    else if (size === defaultFilePreferences.metadata.size) return -2;
    else if (format === defaultFilePreferences.metadata.format) return -3;
    else return -4;
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
