/**
 * FormFooter
 *
 * Footer component for the generation form with quantity input,
 * submit button, reset button, and queue snackbar.
 * Includes alerts for terms agreement, generation status, and errors.
 */

import { Alert, Button, Card, Notification, NumberInput, Text } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconAlertTriangle, IconCheck, IconX } from '@tabler/icons-react';
import { useMemo, useState, type ReactNode } from 'react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import {
  DailyBoostRewardClaim,
  useDailyBoostReward,
} from '~/components/Buzz/Rewards/DailyBoostRewardClaim';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import {
  MembershipUpsell,
  useMembershipUpsell,
} from '~/components/ImageGeneration/MembershipUpsell';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { CustomMarkdown } from '~/components/Markdown/CustomMarkdown';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { Controller, useGraph, MultiController } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { useTipStore } from '~/store/tip.store';
import { hashify } from '~/utils/string-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import {
  useGenerateFromGraph,
  useInvalidateWhatIf,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { useResourceDataContext } from './inputs/ResourceDataProvider';
import { useWhatIfContext } from './WhatIfProvider';
import { filterSnapshotForSubmit } from './utils';
import { getMissingFieldMessage } from './hooks/useWhatIfFromGraph';
import type { SourceMetadata } from '~/store/source-metadata.store';
import { sourceMetadataStore } from '~/store/source-metadata.store';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';
import { useRemixOfId } from './hooks/useRemixOfId';
import { remixStore } from '~/store/remix.store';

// =============================================================================
// Helper Functions
// =============================================================================

interface ResourceSnapshot {
  model?: { id: number };
  resources?: { id: number }[];
  vae?: { id: number };
}

/**
 * Determines if creator tips apply based on selected resources.
 * Creator tips apply when there are any user-created resources (model, LoRAs, VAE).
 */
function getHasCreatorTip(snapshot: ResourceSnapshot): boolean {
  const { model, resources, vae } = snapshot;
  return !!(model?.id || (resources && resources.length > 0) || vae?.id);
}

// =============================================================================
// PriorityAlertSpace Component
// =============================================================================

interface PriorityAlertSpaceProps {
  submitError?: string;
  onClearSubmitError: () => void;
  missingFieldMessage?: string | null;
}

/**
 * Alert space with DailyBoostRewardClaim always on top, then priority-based alerts.
 *
 * Layout:
 * - DailyBoostRewardClaim (always shown if available)
 * - Priority alert (only one shows):
 *   1. Missing field guidance (validation helper)
 *   2. WhatIf error (cost estimation failed)
 *   3. Submit error
 *   4. Membership upsell
 *   5. Queue snackbar (fallback)
 */
function PriorityAlertSpace({
  submitError,
  onClearSubmitError,
  missingFieldMessage,
}: PriorityAlertSpaceProps) {
  const { error: whatIfError, isError: hasWhatIfError } = useWhatIfContext();
  const dailyBoost = useDailyBoostReward();
  const membershipUpsell = useMembershipUpsell();

  // Determine which priority alert to show
  let priorityAlert: ReactNode;
  if (missingFieldMessage) {
    // Show helper message for missing required fields (not an error, just guidance)
    priorityAlert = (
      <Notification
        icon={<IconAlertTriangle size={18} />}
        color="blue"
        className="whitespace-pre-wrap rounded-md bg-blue-8/20"
        withCloseButton={false}
      >
        {missingFieldMessage}
      </Notification>
    );
  } else if (hasWhatIfError && whatIfError) {
    priorityAlert = (
      <Notification
        icon={<IconX size={18} />}
        color="red"
        className="whitespace-pre-wrap rounded-md bg-red-8/20"
        withCloseButton={false}
      >
        {whatIfError.message || 'Failed to estimate generation cost.'}
      </Notification>
    );
  } else if (submitError) {
    priorityAlert = (
      <Notification
        icon={<IconX size={18} />}
        color="red"
        onClose={onClearSubmitError}
        className="whitespace-pre-wrap rounded-md bg-red-8/20"
      >
        {submitError}
      </Notification>
    );
  } else {
    priorityAlert = <QueueSnackbar />;
  }

  return (
    <>
      {dailyBoost.canShow ? (
        <DailyBoostRewardClaim />
      ) : membershipUpsell.canShow ? (
        <MembershipUpsell />
      ) : null}
      {priorityAlert}
    </>
  );
}

// =============================================================================
// SubmitButton Component
// =============================================================================

interface SubmitButtonProps {
  isLoading?: boolean;
  onSubmit?: () => void;
}

function SubmitButton({ isLoading: isSubmitting, onSubmit }: SubmitButtonProps) {
  const graph = useGraph<GenerationGraphTypes>();
  const features = useFeatureFlags();
  const { running, helpers } = useTourContext();
  const { creatorTip, civitaiTip } = useTipStore();

  // Get whatIf data from context (provided by WhatIfProvider)
  // isLoading includes both pending debounce AND fetching states
  const { data, isError, isLoading: isWhatIfLoading, canEstimateCost } = useWhatIfContext();

  // Get values from graph for tip calculation
  const snapshot = graph.getSnapshot() as ResourceSnapshot & { workflow?: string };
  const hasCreatorTip = getHasCreatorTip(snapshot);

  // Calculate tip amounts
  const creatorTipRate = features.creatorComp && hasCreatorTip ? creatorTip : 0;
  const civitaiTipRate = features.creatorComp ? civitaiTip : 0;

  const base = data?.cost?.base ?? 0;
  const totalTip = Math.ceil(base * creatorTipRate) + Math.ceil(base * civitaiTipRate);
  const totalCost = (data?.cost?.total ?? 0) + totalTip;

  const handleClick = () => {
    if (running) helpers?.next();
    onSubmit?.();
  };

  const generateButton = (
    <GenerateButton
      type="button"
      data-tour="gen:submit"
      className="h-full flex-1 px-2"
      loading={isWhatIfLoading || isSubmitting}
      cost={totalCost}
      disabled={isError || !canEstimateCost}
      onClick={handleClick}
      transactions={data?.transactions}
      allowMatureContent={data?.allowMatureContent}
    />
  );

  if (!features.creatorComp) return generateButton;

  return (
    <div className="flex flex-1 items-center gap-1 rounded-md bg-gray-2 p-1 pr-1.5 dark:bg-dark-5">
      {generateButton}
      <GenerationCostPopover
        width={300}
        workflowCost={data?.cost ?? {}}
        hideCreatorTip={!hasCreatorTip}
      />
    </div>
  );
}

// =============================================================================
// FormFooter Component
// =============================================================================

export function FormFooter({ onSubmitSuccess }: { onSubmitSuccess?: () => void } = {}) {
  const graph = useGraph<GenerationGraphTypes>();
  const currentUser = useCurrentUser();
  const status = useGenerationStatus();
  const { running, helpers } = useTourContext();
  const { creatorTip, civitaiTip } = useTipStore();
  const features = useFeatureFlags();
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const remixOfId = useRemixOfId();
  const { resources: resourceData } = useResourceDataContext();
  const invalidateWhatIf = useInvalidateWhatIf();

  // Get validation state from whatIf context
  const { canEstimateCost } = useWhatIfContext();

  // Get user-friendly message if required fields are missing
  const snapshot = graph.getSnapshot() as Record<string, unknown> & { workflow?: string };
  const missingFieldMessage = !canEstimateCost
    ? getMissingFieldMessage(snapshot, snapshot.workflow)
    : null;

  const [submitError, setSubmitError] = useState<string | undefined>();
  const [promptWarning, setPromptWarning] = useState<string | null>(null);
  const [reviewed, setReviewed] = useLocalStorage({
    key: 'review-generation-terms',
    defaultValue: window?.localStorage?.getItem('review-generation-terms') === 'true',
  });

  const messageHash = useMemo(
    () => (status.message ? hashify(status.message).toString() : null),
    [status.message]
  );

  // Get whatIf data for buzz transaction checking
  const { data: whatIfData } = useWhatIfContext();

  // Setup buzz transaction handling
  const { conditionalPerformTransaction } = useBuzzTransaction({
    accountTypes: buzzSpendTypes,
    message: (requiredBalance) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    performTransactionOnPurchase: true,
  });

  const generateMutation = useGenerateFromGraph({
    onError: (error) => {
      const isPOI =
        error.message?.startsWith('Your prompt was flagged') || error.message?.includes('POI');
      if (isPOI) {
        setPromptWarning(error.message);
        currentUser?.refresh();
      } else {
        setSubmitError(error.message ?? 'An unexpected error occurred. Please try again later.');
      }
    },
  });

  const clearWarning = () => setPromptWarning(null);

  const handleSubmit = async () => {
    const result = graph.validate();

    if (!result.success) {
      console.log('Validation failed:', result.errors);
      return;
    }

    setSubmitError(undefined);
    setPromptWarning(null);

    // Filter out computed nodes and disabled resources
    const inputData = filterSnapshotForSubmit(result.data as Record<string, unknown>, {
      computedKeys: graph.getComputedKeys(),
    });

    // Only include creator tip if there are user-created resources
    const snapshot = graph.getSnapshot() as ResourceSnapshot & {
      workflow?: string;
      images?: Array<{ url: string }>;
      video?: string;
    };
    const hasCreatorTip = getHasCreatorTip(snapshot);

    // Check if this is an enhancement workflow and retrieve source metadata
    const isEnhancement = snapshot.workflow
      ? workflowConfigByKey.get(snapshot.workflow)?.enhancement === true
      : false;

    let sourceMetadata: SourceMetadata | undefined;
    if (isEnhancement) {
      // Get the image/video URL from the snapshot
      const imageUrl = snapshot.images?.[0]?.url;
      const videoUrl = snapshot.video;
      const mediaUrl = imageUrl || videoUrl;

      if (mediaUrl) {
        sourceMetadata = sourceMetadataStore.getMetadata(mediaUrl);
      }
    }

    // Calculate total cost including tips
    const creatorTipRate = features.creatorComp && hasCreatorTip ? creatorTip : 0;
    const civitaiTipRate = features.creatorComp ? civitaiTip : 0;
    const base = whatIfData?.cost?.base ?? 0;
    const totalTip = Math.ceil(base * creatorTipRate) + Math.ceil(base * civitaiTipRate);
    const totalCost = (whatIfData?.cost?.total ?? 0) + totalTip;

    // Check if any resources have early access
    const hasEarlyAccess = resourceData.some((x) => x.earlyAccessConfig);

    // Wrap the mutation call with buzz transaction check
    const performTransaction = async () => {
      await generateMutation.mutateAsync({
        input: {
          ...inputData,
          disablePoi: browsingSettingsAddons.settings.disablePoi,
        },
        remixOfId,
        creatorTip: hasCreatorTip ? creatorTip : 0,
        civitaiTip,
        ...(sourceMetadata ? { sourceMetadata } : {}),
      });

      if (hasEarlyAccess) {
        invalidateWhatIf();
      }

      onSubmitSuccess?.();
    };

    conditionalPerformTransaction(totalCost, performTransaction);
  };

  const handleReset = () => {
    // Don't exclude 'model' - it should be reset to match the baseModel
    // The checkpointNode factory will select a default model for the baseModel
    graph.reset({ exclude: ['workflow', 'ecosystem'] });
    remixStore.clearRemix();
    clearWarning();
    setSubmitError(undefined);
  };

  // Render prohibited prompt warning
  if (promptWarning) {
    return (
      <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
        <Alert color="red" title="Prohibited Prompt">
          <Text className="whitespace-pre-wrap">{promptWarning}</Text>
          <Button
            color="red"
            variant="light"
            onClick={clearWarning}
            style={{ marginTop: 10 }}
            leftSection={<IconCheck />}
            fullWidth
          >
            I Understand, Continue Generating
          </Button>
        </Alert>
        {currentUser?.username && (
          <Text size="xs" c="dimmed" mt={4}>
            Is this a mistake?{' '}
            <Text
              component="a"
              td="underline"
              href={`https://forms.clickup.com/8459928/f/825mr-9671/KRFFR2BFKJCROV3B8Q?Civitai Username=${currentUser.username}`}
              target="_blank"
            >
              Submit your prompt for review
            </Text>{' '}
            so we can refine our system.
          </Text>
        )}
      </div>
    );
  }

  // Render generation unavailable alert
  if (!status.available) {
    return (
      <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
        <AlertWithIcon
          color="yellow"
          title="Generation Status Alert"
          icon={<IconAlertTriangle size={20} />}
          iconColor="yellow"
        >
          {status.message}
        </AlertWithIcon>
      </div>
    );
  }

  return (
    <div className="shadow-topper sticky bottom-0 z-10 flex flex-col gap-2 rounded-xl bg-gray-0 p-2 dark:bg-dark-7">
      {/* Terms Agreement Alert */}
      {!reviewed && (
        <Alert color="yellow" title="Image Generation Terms" data-tour="gen:terms">
          <Text size="xs">
            By using the image generator you confirm that you have read and agree to our{' '}
            <Text component={Link} href="/content/tos" td="underline">
              Terms of Service
            </Text>{' '}
            presented during onboarding. Failure to abide by{' '}
            <Text component={Link} href="/safety#content-policies" td="underline">
              our content policies
            </Text>{' '}
            will result in the loss of your access to the image generator. Illegal or exploitative
            content will be removed and reported.
          </Text>
          <Button
            color="yellow"
            variant="light"
            onClick={() => {
              setReviewed(true);
              if (running) helpers?.next();
            }}
            style={{ marginTop: 10 }}
            leftSection={<IconCheck />}
            fullWidth
          >
            I Confirm, Start Generating
          </Button>
        </Alert>
      )}

      {/* Main form footer - only show when terms are reviewed */}
      {reviewed && (
        <>
          <PriorityAlertSpace
            submitError={submitError}
            onClearSubmitError={() => setSubmitError(undefined)}
            missingFieldMessage={missingFieldMessage}
          />

          {/* Quantity Input, Submit Button, Reset Button */}
          <div className="flex min-h-[52px] gap-2">
            <Controller
              graph={graph}
              name="quantity"
              render={({ value, meta, onChange }) => (
                <Card withBorder className="flex max-w-[88px] flex-col p-0">
                  <Text className="pr-6 text-center text-xs font-semibold" c="dimmed">
                    Quantity
                  </Text>
                  <NumberInput
                    value={value ?? 1}
                    onChange={(val) => onChange(Number(val) || 1)}
                    min={meta.min}
                    max={meta.max}
                    step={meta.step}
                    size="md"
                    variant="unstyled"
                    styles={{
                      input: {
                        textAlign: 'center',
                        fontWeight: 700,
                        fontSize: 20,
                        padding: 0,
                      },
                    }}
                  />
                </Card>
              )}
            />
            <SubmitButton isLoading={generateMutation.isLoading} onSubmit={handleSubmit} />
            <Button onClick={handleReset} variant="default" className="h-auto px-3">
              Reset
            </Button>
          </div>
        </>
      )}

      {/* Dismissible Status Message */}
      {status.available && status.message && messageHash && (
        <DismissibleAlert color="yellow" title="Generation Status Alert" id={messageHash}>
          <CustomMarkdown allowedElements={['a', 'strong']} unwrapDisallowed>
            {status.message}
          </CustomMarkdown>
        </DismissibleAlert>
      )}
    </div>
  );
}
