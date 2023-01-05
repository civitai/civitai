import { ModelFileFormat } from '@prisma/client';

import { ModelFileType } from '~/server/common/constants';

export function isPrimaryFile(opts: {
  file: { type: string; format: ModelFileFormat };
  preferredModelFile?: ModelFileType;
  preferredFormat?: ModelFileFormat;
}) {
  const { file, preferredFormat = 'SafeTensor', preferredModelFile = 'Model' } = opts;

  return (
    (file.type === preferredModelFile && file.format === preferredFormat) ||
    (file.type === preferredModelFile && file.format === 'PickleTensor') ||
    (file.type === preferredModelFile && file.format === 'SafeTensor') ||
    (file.type === 'Model' && file.format === preferredFormat) ||
    (file.type === 'Pruned Model' && file.format === preferredFormat) ||
    (file.type === 'Model' && file.format === 'SafeTensor') ||
    (file.type === 'Pruned Model' && file.format === 'SafeTensor') ||
    (file.type === 'Model' && file.format === 'PickleTensor') ||
    (file.type === 'Pruned Model' && file.format === 'PickleTensor')
  );
}
