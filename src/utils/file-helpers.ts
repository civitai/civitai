import { ModelFileFormat } from '@prisma/client';

export function getModelFileFormat(filename: string) {
  if (filename.endsWith('.safetensors')) return ModelFileFormat.SafeTensor;
  else if (filename.endsWith('.pt') || filename.endsWith('.ckpt'))
    return ModelFileFormat.PickleTensor;

  return null;
}
