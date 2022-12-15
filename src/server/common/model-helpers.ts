import { ModelFileFormat, ModelFileType } from '@prisma/client';
import { QS } from '~/utils/qs';

export const createModelFileDownloadUrl = ({
  versionId,
  type,
  format,
  primary = false,
}: {
  versionId: number;
  type?: ModelFileType;
  format?: ModelFileFormat;
  primary?: boolean;
}) => {
  const queryString = QS.stringify({
    type: !primary ? type : null,
    format: !primary && type !== 'TrainingData' ? format : null,
  });

  return `/api/download/models/${versionId}${queryString ? '?' + queryString : ''}`;
};
