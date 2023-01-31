import { Anchor } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconAlertCircle } from '@tabler/icons';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';

export const ModelFileAlert = ({ files, modelType, versionId }: ModelFileAlertProps) => {
  let hasNegativeEmbed = false;
  let hasConfig = false;
  let hasVAE = false;
  if (files) {
    for (const file of files) {
      if (modelType === ModelType.TextualInversion && file.type === 'Negative')
        hasNegativeEmbed = true;
      else if (modelType === ModelType.Checkpoint && file.type === 'Config') hasConfig = true;
      else if (modelType === ModelType.Checkpoint && file.type === 'VAE') hasVAE = true;
    }
  }

  return (
    <>
      {hasNegativeEmbed && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          This Textual Inversion includes a{' '}
          <Anchor
            href={createModelFileDownloadUrl({
              versionId,
              type: 'Negative',
            })}
          >
            Negative embed
          </Anchor>
          , install the negative and use it in the negative prompt for full effect.
        </AlertWithIcon>
      )}
      {hasConfig && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          This checkpoint includes a{' '}
          <Anchor
            href={createModelFileDownloadUrl({
              versionId,
              type: 'Config',
            })}
          >
            config file
          </Anchor>
          , download and place it along side the checkpoint.
        </AlertWithIcon>
      )}
      {hasVAE && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          This checkpoint includes a{' '}
          <Anchor
            href={createModelFileDownloadUrl({
              versionId,
              type: 'VAE',
            })}
          >
            VAE
          </Anchor>
          , download and place it along side the checkpoint.
        </AlertWithIcon>
      )}
    </>
  );
};

type ModelFileAlertProps = {
  files: { type: string }[];
  modelType: ModelType;
  versionId: number;
};
