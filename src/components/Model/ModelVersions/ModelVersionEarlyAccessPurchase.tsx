import { Button, Center, Group, Loader, Modal, Stack, Text, createStyles } from '@mantine/core';
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

export const ModelVersionEarlyAccessPurchase = ({ modelVersionId }: { modelVersionId: number }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const router = useRouter();
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
  const supportsGenerationPurchase =
    supportsGeneration &&
    earlyAccessConfig?.chargeForGeneration &&
    earlyAccessConfig?.generationPrice;

  return (
    <Modal {...dialog} title="Get access to this Model Version!" size="sm" withCloseButton>
      {!earlyAccessConfig || isLoadingAccess ? (
        <Center my="md">
          <Loader />
        </Center>
      ) : (
        <Stack>
          <Text size="sm">
            This model version is in early access. You can get access to it by purchasing it during
            the early access period or just waiting until it becomes public. The remaining time for
            early access is{' '}
            <Text component="span" weight="bold">
              <Countdown endTime={earlyAccessEndsAt ?? new Date()} />
            </Text>
          </Text>
          <Stack>
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
                Generation access is included with download access
              </Text>
            </Stack>

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
                  You will not be able to download this model, but you will be able to generate with
                  it.
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
