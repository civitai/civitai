import { Card } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { ModelFileType } from '~/server/common/constants';

const mapFileTypeAcceptedFileType: Record<ModelFileType, string> = {
  Model: '.ckpt,.pt,.safetensors,.bin',
  'Pruned Model': '.ckpt,.pt,.safetensors',
  Negative: '.pt,.bin',
  'Training Data': '.zip',
  Config: '.yaml,.yml',
  VAE: '.pt,.ckpt,.safetensors',
  'Text Encoder': '.pt',
};

const fileTypesByModelType: Record<ModelType, ModelFileType[]> = {
  TextualInversion: ['Model', 'Negative', 'Training Data'],
  LORA: ['Model', 'Text Encoder', 'Training Data'],
  Checkpoint: ['Model', 'Pruned Model', 'Config', 'VAE', 'Training Data'],
  AestheticGradient: ['Model', 'Training Data'],
  Hypernetwork: ['Model', 'Training Data'],
};

/*
TODO.posts
  - list files
  - add new files
  - update context/store with upload results
  - trpc.modelfiles.create on upload complete
*/

export function Files({ modelVersionId }: FilesProps) {
  return (
    <>
      {/* TODO.dropzone */}
      {/* TODO.list */}
      <Card>
        {/* TODO.file progress */}
        {/* TODO.file type select */}
      </Card>
    </>
  );
}

type FilesProps = {
  modelVersionId: number;
};
