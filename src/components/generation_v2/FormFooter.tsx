/**
 * FormFooter
 *
 * Submit footer for the generation form: quantity input, submit button,
 * reset button, priority alerts (errors, whatIf, missing fields), and
 * queue snackbar. Only used by workflows that actually submit.
 *
 * Layout chrome (sticky wrapper, status, terms, daily boost, dismissible
 * status message) is handled by GenerationLayout.
 */

import {
  ActionIcon,
  Alert,
  Button,
  Card,
  LoadingOverlay,
  Menu,
  Notification,
  NumberInput,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconArrowsShuffle,
  IconCheck,
  IconChevronDown,
  IconDots,
  IconRestore,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import { useMembershipUpsell } from '~/components/ImageGeneration/MembershipUpsell';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { Controller, useGraph, MultiController } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { useGenerationFormStore } from '~/store/generation-form.store';
import { useTipStore } from '~/store/tip.store';
import { abbreviateNumber } from '~/utils/number-helpers';
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
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
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
// Total Cost (including tips)
// =============================================================================

/**
 * Computes the total generation cost including creator and Civitai tips.
 * Used by the buzz type selector, submit button, and insufficient buzz alert.
 */
function useTotalGenerationCost() {
  const graph = useGraph<GenerationGraphTypes>();
  const features = useFeatureFlags();
  const { creatorTip, civitaiTip } = useTipStore();
  const { data } = useWhatIfContext();

  const snapshot = graph.getSnapshot() as ResourceSnapshot & { workflow?: string };
  const hasCreatorTip = getHasCreatorTip(snapshot);

  const creatorTipRate = features.creatorComp && hasCreatorTip ? creatorTip : 0;
  const civitaiTipRate = features.creatorComp ? civitaiTip : 0;
  const base = data?.cost?.base ?? 0;
  const totalTip = Math.ceil(base * creatorTipRate) + Math.ceil(base * civitaiTipRate);

  return (data?.cost?.total ?? 0) + totalTip;
}

// =============================================================================
// Buzz Type Selection
// =============================================================================

/**
 * Returns the available buzz types for generation and the currently selected type.
 * On .com: green + blue. On .red: yellow + blue.
 * Defaults to the site's primary type (green on .com, yellow on .red).
 */
export function useSelectedBuzzType() {
  const availableTypes = useAvailableBuzz(['blue']);
  const storedType = useGenerationFormStore((s) => s.buzzType);
  const setBuzzType = useGenerationFormStore((s) => s.setBuzzType);

  // Default to the site's primary type (first non-blue type, or first available)
  const primaryType = availableTypes.find((t) => t !== 'blue') ?? availableTypes[0];
  const selectedType = storedType && availableTypes.includes(storedType) ? storedType : primaryType;

  return { availableTypes, selectedType, setBuzzType };
}

/**
 * Buzz type selector that shows the current generation cost.
 * The button displays the cost with the selected buzz type icon.
 * The dropdown shows all available buzz types with their balances.
 */
const BUZZ_SELECTOR_SEEN_KEY = 'buzz-type-selector-seen';

export function BuzzTypeSelector({
  cost,
  loading,
  error,
  onRetry,
}: {
  cost: number;
  loading: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  const { availableTypes, selectedType, setBuzzType } = useSelectedBuzzType();
  const buzzConfig = useBuzzCurrencyConfig(selectedType);
  const {
    data: { accounts },
  } = useQueryBuzz(availableTypes);

  // Track whether the user has ever opened the buzz type selector
  const [showGlow, setShowGlow] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(BUZZ_SELECTOR_SEEN_KEY)) setShowGlow(true);
    } catch {}
  }, []);

  const handleMenuOpen = (opened: boolean) => {
    if (opened && showGlow) {
      setShowGlow(false);
      try {
        localStorage.setItem(BUZZ_SELECTOR_SEEN_KEY, '1');
      } catch {}
    }
  };

  const isWhatIfLoading = loading;
  const totalCost = cost;

  // Keep the last known cost so it doesn't flash to 0 during re-fetch
  const lastCostRef = useRef(0);
  if (totalCost > 0) lastCostRef.current = totalCost;
  const displayCost = isWhatIfLoading ? lastCostRef.current : totalCost;
  const showLoading = !error && (isWhatIfLoading || displayCost <= 0);

  // Error state: show retry button instead of cost
  if (error && onRetry) {
    return (
      <Tooltip label="Failed to estimate cost. Click to retry.">
        <Button
          variant="default"
          size="compact-sm"
          className="h-full gap-1 px-2"
          color="red"
          onClick={onRetry}
        >
          <IconAlertTriangle size={14} />
          <IconRestore size={14} />
        </Button>
      </Tooltip>
    );
  }

  return (
    <Menu position="top" withinPortal onChange={handleMenuOpen}>
      <Menu.Target>
        <Button
          variant="default"
          size="compact-sm"
          className={clsx('h-full gap-1 px-2', showGlow && 'animate-buzz-glow')}
          style={
            showGlow ? ({ '--buzz-color': buzzConfig.colorRgb } as React.CSSProperties) : undefined
          }
          color="gray"
          loading={showLoading}
          loaderProps={{ size: 14 }}
        >
          <CurrencyIcon currency={Currency.BUZZ} type={selectedType} size={16} />
          <Text size="sm" fw={600}>
            {numberWithCommas(displayCost)}
          </Text>
          <IconChevronDown size={12} className="ml-0.5" />
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Pay with</Menu.Label>
        {availableTypes.map((buzzType) => {
          const balance = accounts.find((a) => a.type === buzzType)?.balance ?? 0;
          return (
            <Menu.Item
              key={buzzType}
              leftSection={<CurrencyIcon currency={Currency.BUZZ} type={buzzType} size={16} />}
              onClick={() => setBuzzType(buzzType)}
              className={buzzType === selectedType ? 'bg-dark-5' : undefined}
            >
              <Text size="sm" fw={buzzType === selectedType ? 600 : 400}>
                {buzzType.charAt(0).toUpperCase() + buzzType.slice(1)} Buzz —{' '}
                {numberWithCommas(balance)}
              </Text>
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}

/** BuzzTypeSelector wired to the WhatIfProvider context (for use inside FormFooter). */
function ConnectedBuzzTypeSelector() {
  const { isLoading, isError, refetch } = useWhatIfContext();
  const cost = useTotalGenerationCost();
  return (
    <BuzzTypeSelector cost={cost} loading={isLoading} error={isError} onRetry={() => refetch()} />
  );
}

// =============================================================================
// PriorityAlertSpace Component
// =============================================================================

interface PriorityAlertSpaceProps {
  submitError?: string;
  onClearSubmitError: () => void;
  missingFieldMessage?: string | null;
  snackbarRight?: ReactNode;
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
  snackbarRight,
}: PriorityAlertSpaceProps) {
  const { error: whatIfError, isError: hasWhatIfError } = useWhatIfContext();
  const { selectedType, availableTypes, setBuzzType } = useSelectedBuzzType();
  const {
    data: { accounts },
  } = useQueryBuzz(availableTypes);
  const totalCost = useTotalGenerationCost();

  // Check if user has insufficient buzz of the selected type
  const selectedBalance = accounts.find((a) => a.type === selectedType)?.balance ?? 0;
  const insufficientBuzz = totalCost > 0 && selectedBalance < totalCost;

  // Find an alternative buzz type that has enough balance
  const alternativeType = insufficientBuzz
    ? availableTypes.find((t) => {
        if (t === selectedType) return false;
        const balance = accounts.find((a) => a.type === t)?.balance ?? 0;
        return balance >= totalCost;
      })
    : undefined;

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
  } else if (insufficientBuzz) {
    const typeName = selectedType.charAt(0).toUpperCase() + selectedType.slice(1);
    priorityAlert = (
      <Notification
        icon={<IconAlertTriangle size={18} />}
        color="yellow"
        className="whitespace-pre-wrap rounded-md bg-yellow-8/20"
        withCloseButton={false}
      >
        <Text size="sm">
          Not enough {typeName} Buzz ({abbreviateNumber(selectedBalance)}/
          {abbreviateNumber(totalCost)}).{' '}
          {alternativeType ? (
            <Text
              span
              c="blue.4"
              className="cursor-pointer"
              onClick={() => setBuzzType(alternativeType)}
            >
              Switch to {alternativeType.charAt(0).toUpperCase() + alternativeType.slice(1)} Buzz
            </Text>
          ) : (
            <Text span c="blue.4" component="a" href="/purchase/buzz" target="_blank">
              Get more Buzz
            </Text>
          )}
        </Text>
      </Notification>
    );
  }

  return (
    <>
      <QueueSnackbar right={snackbarRight} />
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
  const { running, helpers } = useTourContext();
  const { selectedType } = useSelectedBuzzType();
  const { color } = useBuzzCurrencyConfig(selectedType);

  // Get whatIf data from context (provided by WhatIfProvider)
  const { isError, isLoading: isWhatIfLoading, canEstimateCost } = useWhatIfContext();
  const totalCost = useTotalGenerationCost();

  // Check if user has enough of the selected buzz type
  const {
    data: { accounts },
  } = useQueryBuzz([selectedType]);
  const balance = accounts.find((a) => a.type === selectedType)?.balance ?? 0;
  const insufficientBuzz = totalCost > 0 && balance < totalCost;

  const handleClick = () => {
    if (running) helpers?.next();
    onSubmit?.();
  };

  return (
    <GenerateButton
      type="button"
      data-tour="gen:submit"
      className="h-full flex-1 px-2"
      color={color}
      loading={isSubmitting}
      disabled={isWhatIfLoading || isError || !canEstimateCost || insufficientBuzz}
      onClick={handleClick}
    />
  );
}

/**
 * Cost breakdown info icon for the snackbar.
 * Shows the GenerationCostPopover with tip details when creatorComp is enabled.
 */
function CostBreakdown() {
  const graph = useGraph<GenerationGraphTypes>();
  const features = useFeatureFlags();
  const { data } = useWhatIfContext();

  if (!features.creatorComp) return null;

  const snapshot = graph.getSnapshot() as ResourceSnapshot & { workflow?: string };
  const hasCreatorTip = getHasCreatorTip(snapshot);

  return (
    <GenerationCostPopover
      width={300}
      workflowCost={data?.cost ?? {}}
      hideCreatorTip={!hasCreatorTip}
    />
  );
}

// =============================================================================
// FormFooter Component
// =============================================================================

export function FormFooter({ onSubmitSuccess }: { onSubmitSuccess?: () => void } = {}) {
  const graph = useGraph<GenerationGraphTypes>();
  const currentUser = useCurrentUser();
  const { creatorTip, civitaiTip } = useTipStore();
  const features = useFeatureFlags();
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const remixOfId = useRemixOfId();
  const { resources: resourceData } = useResourceDataContext();
  const invalidateWhatIf = useInvalidateWhatIf();
  const membershipUpsell = useMembershipUpsell();

  // Get validation state from whatIf context
  const { canEstimateCost, validationErrors } = useWhatIfContext();

  // Get user-friendly message if required fields are missing
  const missingFieldMessage = !canEstimateCost ? getMissingFieldMessage(validationErrors) : null;

  const [submitError, setSubmitError] = useState<string | undefined>();
  const [isMinLoading, setIsMinLoading] = useState(false);
  const minLoadingTimer = useRef<ReturnType<typeof setTimeout>>();
  const [promptWarning, setPromptWarning] = useState<string | null>(null);

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

    // Get the user-selected buzz type for this generation
    const { buzzType: selectedBuzzType } = useGenerationFormStore.getState();

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
        tags: [WORKFLOW_TAGS.SOURCE.NEW],
        ...(selectedBuzzType ? { buzzType: selectedBuzzType } : {}),
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
      <>
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
      </>
    );
  }

  return (
    <>
      <PriorityAlertSpace
        submitError={submitError}
        onClearSubmitError={() => setSubmitError(undefined)}
        missingFieldMessage={missingFieldMessage}
        snackbarRight={<CostBreakdown />}
      />

      {!membershipUpsell.needsAcknowledgment && (
        <div className="flex h-[52px] items-stretch gap-2">
          <Controller
            graph={graph}
            name="quantity"
            render={({ value, meta, onChange }) => (
              <Card withBorder className="flex max-w-[68px] flex-col p-0">
                <NumberInput
                  value={value ?? 1}
                  onChange={(val) => onChange(Number(val) || 1)}
                  min={meta.min}
                  max={meta.max}
                  step={meta.step}
                  size="md"
                  variant="unstyled"
                  styles={{
                    root: { flex: 1 },
                    wrapper: { height: '100%' },
                    input: {
                      textAlign: 'center',
                      fontWeight: 600,
                      paddingRight: 27,
                      lineHeight: 1,
                      paddingTop: 6,
                      paddingBottom: 16,
                      height: '100%',
                    },
                  }}
                />
                <Text
                  className="pr-6 text-center text-[10px] font-semibold"
                  c="dimmed"
                  style={{ marginTop: -16 }}
                >
                  QTY
                </Text>
              </Card>
            )}
          />
          <Button.Group className="flex-1">
            <SubmitButton
              isLoading={generateMutation.isLoading || isMinLoading}
              onSubmit={handleSubmit}
            />
            {currentUser && <ConnectedBuzzTypeSelector />}
          </Button.Group>
          <Tooltip label="Reset">
            <ActionIcon onClick={handleReset} variant="default" className="h-auto" size="xl">
              <IconRestore size={16} />
            </ActionIcon>
          </Tooltip>
        </div>
      )}
    </>
  );
}

// =============================================================================
// MetadataExtractionFooter
// =============================================================================

const PRIMARY_WORKFLOW_KEYS = ['txt2img', 'img2img', 'img2img:edit'];

export function MetadataExtractionFooter() {
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
