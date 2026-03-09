/**
 * FormFooter
 *
 * Footer component for the generation form with quantity input,
 * submit button, reset button, and queue snackbar.
 * Includes alerts for terms agreement, generation status, and errors.
 */

import {
  Alert,
  Button,
  Card,
  LoadingOverlay,
  Menu,
  Notification,
  NumberInput,
  Text,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconArrowsShuffle,
  IconCheck,
  IconDots,
  IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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
import {
  workflowConfigByKey,
  getEcosystemsForWorkflow,
  isWorkflowAvailable,
} from '~/shared/data-graph/generation/config/workflows';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import {
  openCompatibilityConfirmModal,
  buildWorkflowPendingChange,
} from '~/components/generation_v2/CompatibilityConfirmModal';
import { workflowPreferences } from '~/store/workflow-preferences.store';
import { useRemixOfId } from './hooks/useRemixOfId';
import { remixStore } from '~/store/remix.store';
import { useMetadataExtractionStore } from '~/store/metadata-extraction.store';
import { useGeneratedItemWorkflows } from './hooks/useGeneratedItemWorkflows';
import { generationGraphStore, REMIX_WORKFLOW_OVERRIDES } from '~/store/generation-graph.store';
import { clearStorageForOutput } from './GenerationFormProvider';

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
  }

  return (
    <>
      {dailyBoost.canShow ? <DailyBoostRewardClaim /> : null}
      <QueueSnackbar />
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
  // isLoading includes both prompt-dirty AND fetching states
  const {
    data,
    isError,
    isLoading: isWhatIfLoading,
    isPromptDirty,
    canEstimateCost,
  } = useWhatIfContext();

  // Pending submit: when the user clicks the loading button while prompt is dirty,
  // we queue the submit and auto-fire it once the whatIf resolves with fresh pricing.
  // Uses state (not a ref) so that setting it triggers a re-render and the effect re-evaluates.
  const [pendingSubmit, setPendingSubmit] = useState(false);

  useEffect(() => {
    if (pendingSubmit && !isWhatIfLoading && !isSubmitting) {
      setPendingSubmit(false);
      onSubmit?.();
    }
  }, [pendingSubmit, isWhatIfLoading, isSubmitting, onSubmit]);

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

  // Allow clicking the loading button when prompt is dirty to queue a pending submit.
  // Clicking the overlay also blurs the prompt, which triggers the whatIf refresh.
  const showPendingOverlay = isPromptDirty && !isSubmitting && !isError && canEstimateCost;

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

  // Overlay to capture clicks on the loading button when prompt is dirty.
  const pendingOverlay = showPendingOverlay ? (
    <div
      className="absolute inset-0 z-10 cursor-pointer"
      onClick={() => {
        // Blur the active element (e.g. prompt textarea) to trigger the whatIf refresh
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        setPendingSubmit(true);
      }}
    />
  ) : null;

  if (!features.creatorComp) {
    // When there's no overlay needed, return the button directly (no wrapper)
    if (!pendingOverlay) return generateButton;

    // Wrapper mirrors the button's flex-1 + h-full so layout is unchanged
    return (
      <div className="relative flex h-full flex-1">
        {generateButton}
        {pendingOverlay}
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 items-center gap-1 rounded-md bg-gray-2 p-1 pr-1.5 dark:bg-dark-5">
      {generateButton}
      {pendingOverlay}
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

export function FormFooter({
  onSubmitSuccess,
  noSubmit,
}: { onSubmitSuccess?: () => void; noSubmit?: boolean } = {}) {
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
  const { canEstimateCost, validationErrors } = useWhatIfContext();

  // Get user-friendly message if required fields are missing
  const missingFieldMessage = !canEstimateCost ? getMissingFieldMessage(validationErrors) : null;

  const [submitError, setSubmitError] = useState<string | undefined>();
  const [isMinLoading, setIsMinLoading] = useState(false);
  const minLoadingTimer = useRef<ReturnType<typeof setTimeout>>();
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

    // Ensure loading state shows for at least 1 second
    clearTimeout(minLoadingTimer.current);
    setIsMinLoading(true);
    minLoadingTimer.current = setTimeout(() => setIsMinLoading(false), 1000);

    // Filter out computed nodes and disabled resources
    const inputData = filterSnapshotForSubmit(result.data as Record<string, unknown>, {
      computedKeys: graph.getComputedKeys(),
    });

    // Only include creator tip if there are user-created resources
    const snapshot = graph.getSnapshot() as ResourceSnapshot & {
      workflow?: string;
      images?: Array<{ url: string }>;
      video?: { url: string };
    };
    const hasCreatorTip = getHasCreatorTip(snapshot);

    // Check if this workflow needs source metadata (for remix-from-original after enhancements)
    const needsSourceMetadata = snapshot.workflow
      ? workflowConfigByKey.get(snapshot.workflow)?.enhancement === true
      : false;

    let sourceMetadata: SourceMetadata | undefined;
    let sourceMetadataMap: Record<string, SourceMetadata> | undefined;
    if (needsSourceMetadata) {
      // Get the image/video URL from the snapshot
      const images = snapshot.images;
      const imageUrl = images?.[0]?.url;
      const videoUrl = snapshot.video?.url;
      const mediaUrl = imageUrl || videoUrl;

      if (mediaUrl) {
        sourceMetadata = sourceMetadataStore.getMetadata(mediaUrl);
      }

      // For multi-image workflows (batch upscale), collect metadata for all images
      if (images && images.length > 1) {
        sourceMetadataMap = {};
        for (const img of images) {
          const meta = sourceMetadataStore.getMetadata(img.url);
          if (meta) sourceMetadataMap[img.url] = meta;
        }
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
        ...(sourceMetadataMap ? { sourceMetadataMap } : {}),
      });

      if (hasEarlyAccess) {
        invalidateWhatIf();
      }

      // Clear media inputs for enhancement workflows so they don't persist in localStorage
      if (needsSourceMetadata) {
        const clear: Record<string, unknown> = {};
        if (snapshot.images?.length) clear.images = [];
        if (snapshot.video) clear.video = undefined;
        if (Object.keys(clear).length > 0) {
          (graph as { set: (v: Record<string, unknown>) => void }).set(clear);
        }
      }

      onSubmitSuccess?.();
    };

    conditionalPerformTransaction(totalCost, performTransaction);
  };

  const handleReset = () => {
    // Determine current output type before resetting
    const snap = graph.getSnapshot() as { output?: string };
    const outputType = (snap.output ?? 'image') as 'image' | 'video';

    // Clear all localStorage for workflows/ecosystems of this output type
    clearStorageForOutput(outputType);

    // Full reset — preserve output preferences (outputFormat, priority)
    graph.reset({ exclude: ['outputFormat', 'priority'] });

    // If video, switch to the default video workflow (graph default is txt2img)
    if (outputType === 'video') {
      graph.set({ workflow: 'txt2vid' } as Parameters<typeof graph.set>[0]);
    }

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

      <PriorityAlertSpace
        submitError={submitError}
        onClearSubmitError={() => setSubmitError(undefined)}
        missingFieldMessage={missingFieldMessage}
      />

      {/* Main form footer - only show when terms are reviewed */}
      {reviewed && !noSubmit && (
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
                  style={{ marginTop: -16 }}
                  styles={{
                    input: {
                      textAlign: 'center',
                      fontWeight: 500,
                      paddingRight: 27,
                      lineHeight: 1,
                      paddingTop: 22,
                      paddingBottom: 6,
                      height: 'auto',
                    },
                  }}
                />
              </Card>
            )}
          />
          <SubmitButton
            isLoading={generateMutation.isLoading || isMinLoading}
            onSubmit={handleSubmit}
          />
          <Button onClick={handleReset} variant="default" className="h-auto px-3">
            Reset
          </Button>
        </div>
      )}

      {/* Metadata extraction remix/workflow buttons */}
      {(graph.getSnapshot() as { workflow?: string }).workflow === 'img2meta' && (
        <MetadataExtractionFooter />
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

// =============================================================================
// MetadataExtractionFooter
// =============================================================================

const PRIMARY_WORKFLOW_KEYS = ['txt2img', 'img2img', 'img2img:edit'];

function MetadataExtractionFooter() {
  const {
    metadata,
    resolvedResources,
    params: serverParams,
    fileUrl,
    isResolving,
  } = useMetadataExtractionStore();

  const hasMetadata = metadata && Object.keys(metadata).length > 0;
  const ecosystemKey = serverParams?.ecosystem as string | undefined;

  const { groups } = useGeneratedItemWorkflows({
    outputType: 'image',
    ecosystemKey,
    filterBy: 'output',
  });

  // Filter to non-enhancement, non-alias, non-img2meta workflows
  const imageWorkflows = (groups.find((g) => g.category === 'image')?.workflows ?? []).filter(
    (w) => !w.enhancement && w.id === w.graphKey && w.graphKey !== 'img2meta'
  );
  const primaryWorkflows = imageWorkflows.filter((w) => PRIMARY_WORKFLOW_KEYS.includes(w.graphKey));
  const secondaryWorkflows = imageWorkflows.filter(
    (w) => !PRIMARY_WORKFLOW_KEYS.includes(w.graphKey)
  );

  const applyToForm = (
    workflowKey: string,
    ecosystem: string | undefined,
    opts?: { withSeed?: boolean; forceImage?: boolean }
  ) => {
    if (!serverParams) return;

    const params: Record<string, unknown> = { ...serverParams, workflow: workflowKey };
    if (ecosystem) params.ecosystem = ecosystem;
    if (!opts?.withSeed) delete params.seed;
    if (opts?.forceImage && fileUrl) {
      params.images = [fileUrl];
    }

    generationGraphStore.setData({
      params,
      resources: ecosystem && ecosystem !== ecosystemKey ? [] : resolvedResources,
      runType: 'remix',
    });
  };

  const handleApply = (
    workflowKey: string,
    opts?: { withSeed?: boolean; forceImage?: boolean }
  ) => {
    if (!serverParams) return;

    const workflowEcosystems = getEcosystemsForWorkflow(workflowKey);
    const isStandalone = workflowEcosystems.length === 0;

    // Standalone workflows (no ecosystem requirement) — apply directly
    if (isStandalone) {
      applyToForm(workflowKey, undefined, opts);
      return;
    }

    // Check if the inferred ecosystem is compatible with the target workflow
    const ecosystemId = ecosystemKey ? ecosystemByKey.get(ecosystemKey)?.id : undefined;
    const compatible = ecosystemId != null && isWorkflowAvailable(workflowKey, ecosystemId);

    if (compatible) {
      // Ecosystem is known and compatible — apply directly
      applyToForm(workflowKey, ecosystemKey, opts);
      return;
    }

    // Ecosystem unknown or incompatible — show ecosystem selection modal
    const storedPref = workflowPreferences.getPreferredEcosystem(workflowKey);
    const storedEco = storedPref ? ecosystemByKey.get(storedPref) : undefined;
    const defaultEcosystemKey = storedEco?.key ?? undefined;

    const pendingChange = {
      ...buildWorkflowPendingChange({
        workflowId: workflowKey,
        currentEcosystem: ecosystemKey ?? '',
        defaultEcosystemKey,
      }),
      incompatible: !!ecosystemKey && !compatible,
    };

    openCompatibilityConfirmModal({
      pendingChange,
      onConfirm: (selectedEcosystemKey) => {
        const targetEco = selectedEcosystemKey ?? pendingChange.defaultEcosystemKey;
        applyToForm(workflowKey, targetEco, opts);
      },
    });
  };

  return (
    <div className="relative flex flex-col gap-2">
      <LoadingOverlay visible={isResolving} loaderProps={{ size: 'sm' }} />
      <div className="flex flex-wrap gap-1">
        {primaryWorkflows.map((w) => (
          <Button
            key={w.id}
            variant="light"
            color="gray"
            size="compact-xs"
            disabled={!hasMetadata || isResolving}
            rightSection={<IconArrowRight size={12} />}
            onClick={() => handleApply(w.graphKey, { forceImage: true })}
          >
            {w.label}
          </Button>
        ))}
        {secondaryWorkflows.length > 0 && (
          <Menu position="top-end" withinPortal>
            <Menu.Target>
              <Button
                variant="light"
                color="gray"
                size="compact-xs"
                disabled={!hasMetadata || isResolving}
              >
                <IconDots size={14} />
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              {secondaryWorkflows.map((w) => (
                <Menu.Item
                  key={w.id}
                  rightSection={<IconArrowRight size={14} />}
                  onClick={() => handleApply(w.graphKey, { forceImage: true })}
                >
                  {w.label}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={!hasMetadata || isResolving}
          leftSection={<IconArrowsShuffle size={16} />}
          onClick={() => {
            const w = (serverParams?.workflow as string) ?? 'txt2img';
            handleApply(REMIX_WORKFLOW_OVERRIDES[w] ?? w);
          }}
        >
          Remix
        </Button>
        <Button
          variant="light"
          disabled={!hasMetadata || isResolving}
          leftSection={<IconArrowsShuffle size={16} />}
          onClick={() => {
            const w = (serverParams?.workflow as string) ?? 'txt2img';
            handleApply(REMIX_WORKFLOW_OVERRIDES[w] ?? w, { withSeed: true });
          }}
        >
          Remix with Seed
        </Button>
      </div>
    </div>
  );
}
