import { Anchor, Text } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconAlertCircle } from '@tabler/icons-react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { BaseModel } from '~/server/common/constants';
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
      {isPony && modelType !== 'Checkpoint' && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          <Text>
            This asset is designed to work best with the{' '}
            <Text
              component="a"
              variant="link"
              td="underline"
              href="/models/257749/pony-diffusion-v6-xl"
              target="_blank"
            >
              Pony Diffusion XL model
            </Text>
            , it will work with other SDXL models but may not look as intended.
          </Text>
        </AlertWithIcon>
      )}
      {onlyPickle && modelType !== 'TextualInversion' && (
        <AlertWithIcon icon={<IconAlertCircle />} iconColor="yellow" color="yellow">
          <Text>
            This asset is only available as a PickleTensor which is a deprecated and insecure format. We caution against using this asset until it can be converted to the modern SafeTensor format.
          </Text>
        </AlertWithIcon>
      )}
      {isWildcards && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          This is a Wildcard collection, it requires an{' '}
          <Anchor
            href="https://github.com/AUTOMATIC1111/stable-diffusion-webui-wildcards"
            rel="nofollow"
            target="_blank"
          >
            additional extension in Automatic 1111
          </Anchor>{' '}
          to work.
        </AlertWithIcon>
      )}
      {isMotion && (
        <AlertWithIcon icon={<IconAlertCircle />}>
          This is a Motion Module for{' '}
          <Anchor href="https://github.com/guoyww/AnimateDiff/" rel="nofollow" target="_blank">
            AnimateDiff
          </Anchor>
          , it requires an{' '}
          <Anchor
            href="https://github.com/continue-revolution/sd-webui-animatediff"
            rel="nofollow"
            target="_blank"
          >
            additional extension in Automatic 1111
          </Anchor>{' '}
          to work.
        </AlertWithIcon>
      )}
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
          This checkpoint recommends a{' '}
          <Anchor
            href={createModelFileDownloadUrl({
              versionId,
              type: 'VAE',
            })}
          >
            VAE
          </Anchor>
          , download and place it in the VAE folder.
        </AlertWithIcon>
      )}
    </>
  );
};

type ModelFileAlertProps = {
  files: { type: string; metadata: { format?: ModelFileFormat; } }[];
  baseModel: BaseModel;
  modelType: ModelType;
  versionId: number;
};
