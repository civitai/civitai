import {
  Anchor,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  createStyles,
} from '@mantine/core';
import { IconAlertCircle } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { Countdown } from '~/components/Countdown/Countdown';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  useModelVersionPermission,
  useMutateModelVersion,
} from '~/components/Model/ModelVersions/model-version.utils';
import { GenerateButton } from '~/components/RunStrategy/GenerateButton';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showSuccessNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';
import { useInvalidateWhatIf } from '~/components/ImageGeneration/utils/generationRequestHooks';

export const ModelVersionEarlyAccessPurchase = ({
  modelVersionId,
  reason,
}: {
  modelVersionId: number;
  reason?: 'download' | 'generation';
}) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const features = useFeatureFlags();
  const {
    isLoadingAccess,
    canDownload,
    canGenerate,
    earlyAccessConfig,
    earlyAccessEndsAt,
    modelVersion,
  } = useModelVersionPermission({
    modelVersionId,
  });
  const { modelVersionEarlyAccessPurchase, purchasingModelVersionEarlyAccess } =
    useMutateModelVersion();

  const invalidateWhatIf = useInvalidateWhatIf();

  const handlePurchase = async (type: 'download' | 'generation' = 'download') => {
    try {
      await modelVersionEarlyAccessPurchase({
        modelVersionId,
        type,
      });

      showSuccessNotification({
        message: `You have successfully purchased access to this model version!  You are now able to ${
          type === 'download' ? 'download & generate with' : 'generate with'
        } this model version`,
      });

      if (type === 'generation') invalidateWhatIf();

      handleClose();
    } catch (e) {
      // Do nothing, handled within the mutation
    }
  };

  const supportsGeneration = features.imageGeneration && modelVersion?.canGenerate;
  const supportsDownloadPurchase =
    earlyAccessConfig?.chargeForDownload && earlyAccessConfig?.downloadPrice;
  const supportsGenerationPurchase =
    supportsGeneration &&
    earlyAccessConfig?.chargeForGeneration &&
    earlyAccessConfig?.generationPrice;

  const userCanDoLabel = [
    supportsDownloadPurchase && 'download',
    supportsGenerationPurchase && 'generate',
  ]
    .filter(Boolean)
    .join(' or ');
  const resourceLabel = getDisplayName(modelVersion?.model.type ?? '');

  return (
    <Modal {...dialog} title="Get access to this Model Version!" size="sm" withCloseButton>
      {!earlyAccessConfig || isLoadingAccess ? (
        <Center my="md">
          <Loader />
        </Center>
      ) : (
        <Stack>
          {reason === 'generation' && supportsGeneration && !supportsGenerationPurchase && (
            <AlertWithIcon icon={<IconAlertCircle />} size="xs" color="yellow" iconColor="yellow">
              The creator of this {resourceLabel} has not made generation available during the early
              access period.
            </AlertWithIcon>
          )}
          {reason === 'download' && !supportsDownloadPurchase && (
            <AlertWithIcon icon={<IconAlertCircle />} size="xs" color="yellow" iconColor="yellow">
              The creator of this {resourceLabel} has not made download access available during the
              early access period.
            </AlertWithIcon>
          )}
          <Text size="sm">
            The creator of this {resourceLabel} has set this version to early access, You can{' '}
            {userCanDoLabel} with this {resourceLabel} by purchasing it during the early access
            period or just waiting until it becomes public. The remaining time for early access is{' '}
            <Text component="span" weight="bold">
              <Countdown endTime={earlyAccessEndsAt ?? new Date()} />
            </Text>
          </Text>
          <Stack>
            {supportsDownloadPurchase && (
              <Stack spacing="xs">
                <BuzzTransactionButton
                  type="submit"
                  label="Get Download Access"
                  loading={purchasingModelVersionEarlyAccess}
                  buzzAmount={earlyAccessConfig?.downloadPrice as number}
                  onPerformTransaction={() => handlePurchase('download')}
                  disabled={canDownload}
                />
                <Text size="xs" color="dimmed">
                  Download access also grants generation access.
                </Text>
              </Stack>
            )}

            {supportsGenerationPurchase && (
              <Stack spacing="xs">
                <BuzzTransactionButton
                  type="submit"
                  label="Get Generation Access"
                  loading={purchasingModelVersionEarlyAccess}
                  buzzAmount={earlyAccessConfig?.generationPrice as number}
                  onPerformTransaction={() => handlePurchase('generation')}
                  disabled={canGenerate}
                />
                <Text size="xs" color="dimmed">
                  The creator of the {resourceLabel} has enabled{' '}
                  {earlyAccessConfig.generationTrialLimit} trials for generation. Test this{' '}
                  {resourceLabel}{' '}
                  <GenerateButton
                    modelVersionId={modelVersionId}
                    data-activity="create:version-stat"
                    onClick={() => {
                      dialog.onClose();
                    }}
                  >
                    <Anchor>here</Anchor>
                  </GenerateButton>
                  .
                </Text>
                <Text size="xs" color="dimmed">
                  By purchasing generation access, you will not be able to download this resource,
                  but you can make unlimited generations with it
                </Text>
              </Stack>
            )}

            <Button onClick={handleClose} variant="light" color="gray" compact>
              Cancel
            </Button>
          </Stack>
        </Stack>
      )}
    </Modal>
  );
};
