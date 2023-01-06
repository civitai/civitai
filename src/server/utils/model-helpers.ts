import { ModelFileFormat } from '@prisma/client';

import { ModelFileType } from '~/server/common/constants';

const defaultPreferences = { preferredType: 'Model', preferredFormat: 'SafeTensor' };
export function getPrimaryFile<T extends { type: string; format: ModelFileFormat }>(
  files: Array<T>,
  preferences?: { preferredType?: ModelFileType; preferredFormat?: ModelFileFormat }
) {
  if (!files || files.length === 0) return null;

  const { preferredFormat, preferredType } = preferences ?? defaultPreferences;
  const getScore = (file: { type: string; format: ModelFileFormat }) => {
    if (file.type == preferredType && file.format == preferredFormat) return 4;
    else if (file.format == preferredFormat) return 3;
    else if (file.type == preferredType) return 2;
    else if (
      file.type == defaultPreferences.preferredType &&
      file.format == defaultPreferences.preferredFormat
    )
      return 1;
    else if (file.type == defaultPreferences.preferredType) return 0;
    else if (file.format == defaultPreferences.preferredFormat) return -1;
    else return -2;
  };

  return files
    .map((file) => ({
      file,
      score: getScore(file),
    }))
    .sort((a, b) => a.score - b.score)[0].file;
}
