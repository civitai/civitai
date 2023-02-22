type FileFormatType = {
  metadata: FileMetadata;
};

export const defaultFilePreferences: FileFormatType = {
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

    if (size === preferredSize && format === preferredFormat && fp === preferredFp) return 4;
    else if (size === preferredSize && format === preferredFormat) return 3;
    else if (format === preferredFormat) return 2;
    else if (size === preferredSize) return 1;
    else if (
      size === defaultFilePreferences.metadata.size &&
      format === defaultFilePreferences.metadata.format &&
      fp === preferredFp
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
