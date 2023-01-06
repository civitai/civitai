import { ModelFileFormat } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';

type FileFormatType = {
  type: string | ModelFileType;
  format: ModelFileFormat;
};

export const defaultFilePreferences: FileFormatType = {
  type: 'Model',
  format: 'SafeTensor',
};
export function getPrimaryFile<T extends FileFormatType>(
  files: Array<T>,
  preferences?: Partial<FileFormatType>
) {
  if (!files || files.length === 0) return null;

  let { format: preferredFormat, type: preferredType } = preferences ?? {};
  preferredFormat ??= defaultFilePreferences.format;
  preferredType ??= defaultFilePreferences.type;

  const getScore = (file: { type: string; format: ModelFileFormat }) => {
    if (file.type == preferredType && file.format == preferredFormat) return 4;
    else if (file.format == preferredFormat) return 3;
    else if (file.type == preferredType) return 2;
    else if (
      file.type == defaultFilePreferences.type &&
      file.format == defaultFilePreferences.format
    )
      return 1;
    else if (file.type == defaultFilePreferences.type) return 0;
    else if (file.format == defaultFilePreferences.format) return -1;
    else return -2;
  };

  return files
    .map((file) => ({
      file,
      score: getScore(file),
    }))
    .sort((a, b) => b.score - a.score)[0].file;
}
