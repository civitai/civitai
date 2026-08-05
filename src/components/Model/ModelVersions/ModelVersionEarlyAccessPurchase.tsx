import { Button, Center, Divider, Loader, Modal, Stack, Text } from '@mantine/core';
import {
  type ModelVersionTerms,
  generationPrice,
  generationTrialLimit,
  isPermanentGate,
} from '@civitai/buzz';
import { IconAlertCircle, IconBrush } from '@tabler/icons-react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { Countdown } from '~/components/Countdown/Countdown';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useInvalidateWhatIf } from '~/components/ImageGeneration/utils/generationRequestHooks';
import {
  useModelVersionPermission,
  useMutateModelVersion,
} from '~/components/Model/ModelVersions/model-version.utils';
import { GenerateButton } from '~/components/RunStrategy/GenerateButton';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showSuccessNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';

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
  const { isLoadingAccess, canDownload, generationRequiresPurchase, paidAccess, modelVersion } =
    useModelVersionPermission({
      modelVersionId,
    });
  const { modelVersionEarlyAccessPurchase, purchasingModelVersionEarlyAccess } =
    useMutateModelVersion();

  const paidAccessTerms = paidAccess?.terms as ModelVersionTerms | undefined;
  const downloadPrice = paidAccessTerms?.download?.price;
  const genPrice = paidAccessTerms ? generationPrice(paidAccessTerms) : undefined;
  const genTrialLimit = paidAccessTerms ? generationTrialLimit(paidAccessTerms) : 0;

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
  const supportsDownloadPurchase = !!downloadPrice;
  const supportsGenerationPurchase = supportsGeneration && !!genPrice;
  const supportsTrialGeneration =
    supportsGeneration && genTrialLimit > 0 && generationRequiresPurchase;

  const userCanDoLabel = [
    supportsDownloadPurchase && 'download',
    supportsGenerationPurchase && 'generate',
  ]
    .filter(Boolean)
    .join(' or ');
  const resourceLabel = getDisplayName(modelVersion?.model.type ?? '');
  // A permanent gate never becomes free, so the timed copy (and its countdown to nothing) would tell the
  // buyer to just wait it out.
  const permanent = !!paidAccess && isPermanentGate(paidAccess);

  return (
    <Modal {...dialog} title="Get access to this Model Version!" size="sm" withCloseButton>
      {!paidAccess || isLoadingAccess ? (
        <Center my="md">
          <Loader />
        </Center>
      ) : (
        <Stack>
          {reason === 'generation' && supportsGeneration && !supportsGenerationPurchase && (
            <AlertWithIcon icon={<IconAlertCircle />} size="xs" color="yellow" iconColor="yellow">
              The creator of this {resourceLabel} has not made generation available
              {permanent ? '' : ' during the early access period'}.
            </AlertWithIcon>
          )}
          {reason === 'download' && !supportsDownloadPurchase && (
            <AlertWithIcon icon={<IconAlertCircle />} size="xs" color="yellow" iconColor="yellow">
              The creator of this {resourceLabel} has not made download access available
              {permanent ? '' : ' during the early access period'}.
            </AlertWithIcon>
          )}
          {permanent ? (
            <Text size="sm">
              The creator of this {resourceLabel} charges for access. You can {userCanDoLabel} with
              this {resourceLabel} by purchasing it — access is permanent and does not expire.
            </Text>
          ) : (
            <Text size="sm">
              The creator of this {resourceLabel} has set this version to early access, You can{' '}
              {userCanDoLabel} with this {resourceLabel} by purchasing it during the early access
              period or just waiting until it becomes public. The remaining time for early access is{' '}
              <Text component="span" fw="bold">
                <Countdown endTime={paidAccess?.endsAt ?? new Date()} />
              </Text>
            </Text>
          )}
          <Stack>
            {supportsDownloadPurchase && (
              <Stack gap="xs">
                <BuzzTransactionButton
                  type="submit"
                  label="Get Download Access"
                  loading={purchasingModelVersionEarlyAccess}
                  buzzAmount={downloadPrice as number}
                  onPerformTransaction={() => handlePurchase('download')}
                  disabled={canDownload}
                />
                <Text size="xs" c="dimmed">
                  Download access also grants generation access.
                </Text>
              </Stack>
            )}

            {supportsGenerationPurchase && (
              <Stack gap="xs">
                <BuzzTransactionButton
                  type="submit"
                  label="Get Generation Access"
                  loading={purchasingModelVersionEarlyAccess}
                  buzzAmount={genPrice as number}
                  onPerformTransaction={() => handlePurchase('generation')}
                  disabled={!generationRequiresPurchase}
                />
                <Text size="xs" c="dimmed">
                  By purchasing generation access, you will not be able to download this resource,
                  but you can make unlimited generations with it
                </Text>
              </Stack>
            )}

            {supportsTrialGeneration && (
              <Stack gap="xs">
                <Divider label="or try it first" labelPosition="center" />
                <GenerateButton
                  versionId={modelVersionId}
                  modelId={modelVersion?.model?.id}
                  data-activity="create:version-trial"
                  onClick={handleClose}
                >
                  <Button variant="light" fullWidth leftSection={<IconBrush size={18} />}>
                    Try it free
                  </Button>
                </GenerateButton>
                <Text size="xs" c="dimmed">
                  The creator of this {resourceLabel} has enabled up to{' '}
                  {genTrialLimit.toLocaleString()} free trial generation
                  {genTrialLimit === 1 ? '' : 's'} before purchase is required.
                </Text>
              </Stack>
            )}

            <Button onClick={handleClose} variant="light" color="gray" size="compact-sm">
              Cancel
            </Button>
          </Stack>
        </Stack>
      )}
    </Modal>
  );
};
