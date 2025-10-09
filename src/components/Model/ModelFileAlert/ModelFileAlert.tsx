import { Anchor, Text } from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { ModelType, ModelUsageControl } from '~/shared/utils/prisma/enums';

export const ModelFileAlert = ({
  files,
  modelType,
  versionId,
  baseModel,
  usageControl,
}: ModelFileAlertProps) => {
  let hasNegativeEmbed = false;
  let hasConfig = false;
  let hasVAE = false;
  let hasPickle = false;
  let onlyPickle = true;
  // const isPony = baseModel === 'Pony';

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
      {onlyPickle && usageControl === ModelUsageControl.Download && (
        <AlertWithIcon icon={<IconAlertCircle />} iconColor="yellow" color="yellow">
          <Text size="xs">
            {modelType === 'TextualInversion' || modelType === 'Hypernetwork'
              ? "This asset is only available as a PickleTensor which is an insecure format. We've taken precautions to ensure the safety of these files but please be aware that some may harbor malicious code."
              : 'This asset is only available as a PickleTensor which is a deprecated and insecure format. We caution against using this asset until it can be converted to the modern SafeTensor format.'}
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
  usageControl: ModelUsageControl;
};
