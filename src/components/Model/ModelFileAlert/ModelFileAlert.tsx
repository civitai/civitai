import { Anchor, Text } from '@mantine/core';
import { ModelType } from '~/shared/utils/prisma/enums';
import { IconAlertCircle } from '@tabler/icons-react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';

export const ModelFileAlert = ({ files, modelType, versionId, baseModel }: ModelFileAlertProps) => {
  let hasNegativeEmbed = false;
  let hasConfig = false;
  let hasVAE = false;
  let hasPickle = false;
  let onlyPickle = true;
  const isWildcards = modelType === ModelType.Wildcards;
  const isMotion = modelType === ModelType.MotionModule;
  const isPony = baseModel === 'Pony';
  if (files) {
    for (const file of files) {
      if (file.metadata.format === 'PickleTensor') hasPickle = true;
      if (file.metadata.format !== 'PickleTensor' && file.type === 'Model') onlyPickle = false;
      if (modelType === ModelType.TextualInversion && file.type === 'Negative')
        hasNegativeEmbed = true;
      else if (file.type === 'Config') hasConfig = true;
      else if (modelType === ModelType.Checkpoint && file.type === 'VAE') hasVAE = true;
    }
  }
  if (!hasPickle) onlyPickle = false;

  return (
    <>
      {onlyPickle && (
        <AlertWithIcon icon={<IconAlertCircle />} iconColor="yellow" color="yellow">
          <Text size="xs">
            {modelType === 'TextualInversion' || modelType === 'Hypernetwork'
              ? "This asset is only available as a PickleTensor which is an insecure format. We've taken precautions to ensure the safety of these files but please be aware that some may harbor malicious code."
              : 'This asset is only available as a PickleTensor which is a deprecated and insecure format. We caution against using this asset until it can be converted to the modern SafeTensor format.'}
          </Text>
        </AlertWithIcon>
      )}
      {isWildcards && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          <Text size="xs">
            This is a Wildcard collection, it requires an{' '}
            <Anchor
              className="inline-flex"
              href="https://github.com/AUTOMATIC1111/stable-diffusion-webui-wildcards"
              rel="nofollow"
              target="_blank"
              inherit
            >
              additional extension in Automatic 1111
            </Anchor>{' '}
            to work.
          </Text>
        </AlertWithIcon>
      )}
      {isMotion && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          <Text size="xs">
            This is a Motion Module for{' '}
            <Anchor
              className="inline-flex"
              href="https://github.com/guoyww/AnimateDiff/"
              rel="nofollow"
              target="_blank"
              inherit
            >
              AnimateDiff
            </Anchor>
            , it requires an{' '}
            <Anchor
              className="inline-flex"
              href="https://github.com/continue-revolution/sd-webui-animatediff"
              rel="nofollow"
              target="_blank"
              inherit
            >
              additional extension in Automatic 1111
            </Anchor>{' '}
            to work.
          </Text>
        </AlertWithIcon>
      )}
      {hasNegativeEmbed && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          <Text size="xs">
            This Textual Inversion includes a{' '}
            <Anchor
              className="inline-flex"
              href={createModelFileDownloadUrl({
                versionId,
                type: 'Negative',
              })}
              inherit
            >
              Negative embed
            </Anchor>
            , install the negative and use it in the negative prompt for full effect.
          </Text>
        </AlertWithIcon>
      )}
      {hasConfig && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          <Text size="xs">
            This checkpoint includes a{' '}
            <Anchor
              className="inline-flex"
              href={createModelFileDownloadUrl({
                versionId,
                type: 'Config',
              })}
              inherit
            >
              config file
            </Anchor>
            , download and place it along side the checkpoint.
          </Text>
        </AlertWithIcon>
      )}
      {hasVAE && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          <Text size="xs">
            This checkpoint recommends a{' '}
            <Anchor
              className="inline-flex"
              href={createModelFileDownloadUrl({
                versionId,
                type: 'VAE',
              })}
              inherit
            >
              VAE
            </Anchor>
            , download and place it in the VAE folder.
          </Text>
        </AlertWithIcon>
      )}
    </>
  );
};

type ModelFileAlertProps = {
  files: { type: string; metadata: { format?: ModelFileFormat } }[];
  baseModel: BaseModel;
  modelType: ModelType;
  versionId: number;
};
