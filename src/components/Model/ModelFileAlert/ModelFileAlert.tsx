import { Anchor, Text } from '@mantine/core';
import { ModelType } from '~/shared/utils/prisma/enums';
import { IconAlertCircle } from '@tabler/icons-react';
import styles from './ModelFileAlert.module.scss';

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
      {onlyPickle && (
        <AlertWithIcon
          icon={<IconAlertCircle className={styles.alertIcon} />}
          iconColor="yellow"
          color="yellow"
          className={`${styles.alert} ${styles.warningAlert}`}
        >
          <Text className={styles.alertText}>
            {modelType === 'TextualInversion' || modelType === 'Hypernetwork'
              ? "This asset is only available as a PickleTensor which is an insecure format. We've taken precautions to ensure the safety of these files but please be aware that some may harbor malicious code."
              : 'This asset is only available as a PickleTensor which is a deprecated and insecure format. We caution against using this asset until it can be converted to the modern SafeTensor format.'}
          </Text>
        </AlertWithIcon>
      )}
      {isWildcards && (
        <AlertWithIcon
          icon={<IconAlertCircle className={styles.alertIcon} />}
          className={`${styles.alert} ${styles.infoAlert}`}
        >
          <Text className={styles.alertText}>
            This is a Wildcard collection, it requires an{' '}
            <Anchor
              href="https://github.com/AUTOMATIC1111/stable-diffusion-webui-wildcards"
              rel="nofollow"
              target="_blank"
              className={styles.link}
            >
              additional extension in Automatic 1111
            </Anchor>{' '}
            to work.
          </Text>
        </AlertWithIcon>
      )}
      {isMotion && (
        <AlertWithIcon
          icon={<IconAlertCircle className={styles.alertIcon} />}
          className={`${styles.alert} ${styles.infoAlert}`}
        >
          <Text className={styles.alertText}>
            This is a Motion Module for{' '}
            <Anchor
              href="https://github.com/guoyww/AnimateDiff/"
              rel="nofollow"
              target="_blank"
              className={styles.link}
            >
              AnimateDiff
            </Anchor>
            , it requires an{' '}
            <Anchor
              href="https://github.com/continue-revolution/sd-webui-animatediff"
              rel="nofollow"
              target="_blank"
              className={styles.link}
            >
              additional extension in Automatic 1111
            </Anchor>{' '}
            to work.
          </Text>
        </AlertWithIcon>
      )}
      {hasNegativeEmbed && (
        <AlertWithIcon
          icon={<IconAlertCircle className={styles.alertIcon} />}
          className={`${styles.alert} ${styles.infoAlert}`}
        >
          <Text className={styles.alertText}>
            This Textual Inversion includes a{' '}
            <Anchor
              href={createModelFileDownloadUrl({
                versionId,
                type: 'Negative',
              })}
              className={styles.link}
            >
              Negative embed
            </Anchor>
            , install the negative and use it in the negative prompt for full effect.
          </Text>
        </AlertWithIcon>
      )}
      {hasConfig && (
        <AlertWithIcon
          icon={<IconAlertCircle className={styles.alertIcon} />}
          className={`${styles.alert} ${styles.infoAlert}`}
        >
          <Text className={styles.alertText}>
            This checkpoint includes a{' '}
            <Anchor
              href={createModelFileDownloadUrl({
                versionId,
                type: 'Config',
              })}
              className={styles.link}
            >
              config file
            </Anchor>
            , download and place it along side the checkpoint.
          </Text>
        </AlertWithIcon>
      )}
      {hasVAE && (
        <AlertWithIcon
          icon={<IconAlertCircle className={styles.alertIcon} />}
          className={`${styles.alert} ${styles.infoAlert}`}
        >
          <Text className={styles.alertText}>
            This checkpoint recommends a{' '}
            <Anchor
              href={createModelFileDownloadUrl({
                versionId,
                type: 'VAE',
              })}
              className={styles.link}
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

