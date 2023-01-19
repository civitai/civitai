import { Anchor, Text } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconAlertCircle } from '@tabler/icons';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Countdown } from '~/components/Countdown/Countdown';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createModelFileDownloadUrl } from '~/server/common/model-helpers';
import { isFutureDate } from '~/utils/date-helpers';

export const ModelFileAlert = ({
  files,
  modelType,
  versionId,
  earlyAccessDeadline,
}: ModelFileAlertProps) => {
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

  const features = useFeatureFlags();
  const inEarlyAccess =
    features.earlyAccessModel && !!earlyAccessDeadline && isFutureDate(earlyAccessDeadline);

  return (
    <>
      {inEarlyAccess && (
        <AlertWithIcon color="green" iconColor="green" icon={<IconAlertCircle />}>
          {`This checkpoint is marked as Supporter's only. Come back in `}
          <Countdown endTime={earlyAccessDeadline} />
          {' to download for free. '}
          <Text
            variant="link"
            onClick={() => console.log('Add notification')}
            sx={{ cursor: 'pointer' }}
            span
          >
            Notify me when it is available.
          </Text>
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
  earlyAccessDeadline?: Date;
};
