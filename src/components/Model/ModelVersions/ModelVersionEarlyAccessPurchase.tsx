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
import { useRouter } from 'next/router';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { Countdown } from '~/components/Countdown/Countdown';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  useModelVersionPermission,
  useMutateModelVersion,
} from '~/components/Model/ModelVersions/model-version.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showSuccessNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';

export const ModelVersionEarlyAccessPurchase = ({ modelVersionId }: { modelVersionId: number }) => {
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

  const userCanDoLabel = [canDownload && 'download', canGenerate && 'generate']
    .filter(Boolean)
    .join(' or ');
  const resourceLabel = getDisplayName(modelVersion?.model.type ?? '').toLowerCase();

  return (
    <Modal {...dialog} title="Get access to this Model Version!" size="sm" withCloseButton>
      {!earlyAccessConfig || isLoadingAccess ? (
        <Center my="md">
          <Loader />
        </Center>
      ) : (
        <Stack>
          <Text size="sm">
            The creator of this {resourceLabel} has set this version to early access, You can{' '}
            {userCanDoLabel} with this {resourceLabel} by purchasing it during the early access
            period or just waiting untill it becomes public. The remaining time for early access is{' '}
            <Text component="span" weight="bold">
              <Countdown endTime={earlyAccessEndsAt ?? new Date()} />
            </Text>
          </Text>
          <Stack>
            {supportsDownloadPurchase && (
              <Stack spacing={0}>
                <BuzzTransactionButton
                  type="submit"
                  label="Get Download Access"
                  loading={purchasingModelVersionEarlyAccess}
                  buzzAmount={earlyAccessConfig?.downloadPrice}
                  onPerformTransaction={() => handlePurchase('download')}
                  disabled={canDownload}
                />
                <Text size="xs" color="dimmed">
                  Download access also grants generation access, this does not contribute to the
                  donation goal
                </Text>
              </Stack>
            )}

            {supportsGenerationPurchase && (
              <Stack spacing={0}>
                <BuzzTransactionButton
                  type="submit"
                  label="Get Generation Access"
                  loading={purchasingModelVersionEarlyAccess}
                  buzzAmount={earlyAccessConfig?.generationPrice as number}
                  onPerformTransaction={() => handlePurchase('generation')}
                  disabled={canGenerate}
                />
                <Text size="xs" color="dimmed">
                  The creator of the {resourceLabel} has enabled trials, test this {resourceLabel}{' '}
                  <Anchor href="/test">here</Anchor>. You will not be able to download this
                  resource, but you can make unlimited generations with it, this does not contribute
                  to the donation goal.
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
