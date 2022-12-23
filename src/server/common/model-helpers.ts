import { ModelFileFormat } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';
import { QS } from '~/utils/qs';

export const createModelFileDownloadUrl = ({
  versionId,
  type,
  format,
  primary = false,
}: {
  versionId: number;
  type?: ModelFileType | string;
  format?: ModelFileFormat;
  primary?: boolean;
}) => {
  const queryString = QS.stringify({
    type: !primary ? type : null,
    format: !primary && type !== 'Training Data' ? format : null,
  });

  return `/api/download/models/${versionId}${queryString ? '?' + queryString : ''}`;
};
