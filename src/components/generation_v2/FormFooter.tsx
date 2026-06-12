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
  Popover,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconArrowsShuffle,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
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
import { useServerDomains } from '~/providers/AppProvider';
import { syncAccount } from '~/utils/sync-account';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import {
  Controller,
  useGraph,
  useGraphSubscriptions,
  MultiController,
} from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { useGenerationContextStore } from '~/components/ImageGeneration/GenerationProvider';
import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useGenerationFormStore } from '~/store/generation-form.store';
import { showWarningNotification } from '~/utils/notifications';
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
import {
  pickStrongerGate,
  rulesToStates,
  type GateResolution,
} from '~/shared/data-graph/generation/gates';
import {
  LTXV23_MAX_QUANTITY,
  SDCPP_EXCLUDED_MODEL_IDS,
  SDCPP_SUPPORTED_ECOSYSTEMS,
} from '~/shared/constants/generation.constants';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
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
import {
  generationGraphStore,
  REMIX_WORKFLOW_OVERRIDES,
  useGenerationGraphStore,
} from '~/store/generation-graph.store';
import { clearStorageForOutput } from './GenerationFormProvider';
import { useTrackEvent } from '~/components/TrackView/track.utils';

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
 * On .com: green + blue (+ yellow if the user has a yellow balance, so we can
 * surface it in the selector and route them to .red via the upsell alert).
 * On .red: yellow + blue.
 * Defaults to the site's primary type (green on .com, yellow on .red).
 */
export function useSelectedBuzzType() {
  const features = useFeatureFlags();
  const baseAvailableTypes = useAvailableBuzz(['blue']);
  const storedType = useGenerationFormStore((s) => s.buzzType);
  const setBuzzType = useGenerationFormStore((s) => s.setBuzzType);

  const {
    data: { accounts: yellowAccounts },
  } = useQueryBuzz(['yellow']);
  const yellowBalance = yellowAccounts.find((a) => a.type === 'yellow')?.balance ?? 0;
  const showYellowOnGreen = features.isGreen && yellowBalance > 0;

  const availableTypes: BuzzSpendType[] = showYellowOnGreen
    ? [...baseAvailableTypes, 'yellow']
    : baseAvailableTypes;

  // Default to the site's primary spendable type (skip yellow on .com — it's
  // shown only as a routing hint, not as a real default).
  const primaryType =
    availableTypes.find((t) => t !== 'blue' && !(features.isGreen && t === 'yellow')) ??
    availableTypes[0];
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
// Self-Hosted Blocked Alert
// =============================================================================

/**
 * Detects whether the SELECTED ecosystem is shown-but-disabled for the current
 * user, merging every gate source — the self-hosted toggle and the rules model
 * — into one resolution (the picker already filtered out hidden ones, so a
 * selected value is at worst `disabled`/`memberOnly`). Returns the blocked
 * ecosystem key (or undefined) plus its state + optional rule message. Consumed
 * by `GenerationLayout`, which renders `SelfHostedBlockedAlert` in the same slot
 * as `MembershipUpsell` and hides the form controls while blocked.
 */
export function useSelfHostedBlock() {
  const { selfHostedMode, selfHostedDisabledEcosystems, gateRules } = useGenerationConfig();
  const graph = useGraph<GenerationGraphTypes>();
  // Subscribe to only `ecosystem` — not the whole graph — so prompt/seed/etc.
  // edits (which fire the global watcher) don't needlessly re-render this.
  const { ecosystem: selectedEcosystem } = useGraphSubscriptions(graph, ['ecosystem'] as const) as {
    ecosystem?: string;
  };
  if (!selectedEcosystem)
    return { blockedEcosystem: undefined, state: undefined, message: undefined };

  let resolution: GateResolution | undefined;
  if (selfHostedDisabledEcosystems.includes(selectedEcosystem))
    resolution = pickStrongerGate(resolution, {
      state: selfHostedMode === 'memberOnly' ? 'memberOnly' : 'disabled',
    });
  const ruleRes = rulesToStates(gateRules).ecosystems.get(selectedEcosystem);
  if (ruleRes) resolution = pickStrongerGate(resolution, ruleRes);

  // A selected ecosystem is never 'hidden' (filtered from the picker); fold any
  // stray hidden into the disabled alert defensively.
  const state = resolution
    ? resolution.state === 'memberOnly'
      ? 'memberOnly'
      : 'disabled'
    : undefined;
  return {
    blockedEcosystem: resolution ? selectedEcosystem : undefined,
    state,
    message: resolution?.message,
  };
}

/**
 * Footer-spanning alert shown when the selected ecosystem can't be generated
 * (self-hosted toggle or a gate rule). Styled like `MembershipUpsell`
 * (edge-to-edge, bigger title, filled CTA). `memberOnly` → membership upsell
 * with a "Become a member" button; `disabled` → temporarily unavailable. A
 * rule's `message` overrides only the body copy, layered on the same
 * badge/title/CTA. Renders null when not blocked.
 */
export function SelfHostedBlockedAlert() {
  const { blockedEcosystem, state, message } = useSelfHostedBlock();
  const serverDomains = useServerDomains();

  if (!blockedEcosystem) return null;

  const displayName = ecosystemByKey.get(blockedEcosystem)?.displayName ?? blockedEcosystem;

  if (state === 'memberOnly') {
    return (
      <Alert color="yellow" className="-m-2 rounded-none rounded-t-xl">
        <Text
          size="sm"
          fw={700}
          c="var(--mantine-color-yellow-light-color)"
          className="flex items-center gap-1.5"
        >
          <IconAlertTriangle size={16} />
          {displayName} is temporarily members-only
        </Text>
        <Text size="xs" mt={4}>
          {message ?? (
            <>
              We&apos;re in the middle of a GPU crunch, so {displayName} is limited to members at
              the moment. Become a member to generate with it now, or pick a different base model.{' '}
              <Text
                span
                c="var(--mantine-color-yellow-light-color)"
                td="underline"
                className="cursor-pointer"
                component="a"
                href="/articles/30980/a-gpu-crunch-and-bumpy-days-ahead"
                target="_blank"
                rel="noreferrer nofollow"
              >
                Read what&apos;s going on
              </Text>
            </>
          )}
        </Text>
        <div className="mt-3 flex items-center gap-3">
          <Button
            component="a"
            href={syncAccount(`//${serverDomains.green}/pricing`)}
            target="_blank"
            rel="noreferrer nofollow"
            variant="filled"
            className="flex-1"
          >
            Become a member
          </Button>
        </div>
      </Alert>
    );
  }

  return (
    <Alert color="red" className="-m-2 rounded-none rounded-t-xl">
      <Text
        size="sm"
        fw={700}
        c="var(--mantine-color-red-light-color)"
        className="flex items-center gap-1.5"
      >
        <IconAlertTriangle size={16} />
        {displayName} is currently unavailable
      </Text>
      <Text size="xs" mt={4}>
        {message ??
          `${displayName} generation is temporarily disabled. Choose a different base model or try again later.`}
      </Text>
    </Alert>
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
  /**
   * When true, force the insufficient-buzz alert (with switch-buzz-type prompt)
   * even if the client-side balance check currently passes. Set by the submit
   * handler when the server rejects with `insufficientBuzz` — the client-side
   * balance may be stale vs. the server's view, so we trust the server signal.
   */
  forceInsufficientBuzz?: boolean;
  onClearInsufficientBuzz?: () => void;
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
  forceInsufficientBuzz,
  onClearInsufficientBuzz,
}: PriorityAlertSpaceProps) {
  const { error: whatIfError, isError: hasWhatIfError } = useWhatIfContext();
  const { selectedType, availableTypes, setBuzzType } = useSelectedBuzzType();
  const {
    data: { accounts },
    isLoading: isBuzzLoading,
  } = useQueryBuzz(availableTypes);
  const totalCost = useTotalGenerationCost();
  const featureFlags = useFeatureFlags();
  const graph = useGraph<GenerationGraphTypes>();

  // Check if user has insufficient buzz of the selected type
  // Don't show insufficient buzz until the buzz query has resolved
  const selectedBalance = accounts.find((a) => a.type === selectedType)?.balance ?? 0;
  const clientInsufficientBuzz = !isBuzzLoading && totalCost > 0 && selectedBalance < totalCost;
  const insufficientBuzz = clientInsufficientBuzz || !!forceInsufficientBuzz;

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
        <div className="flex w-full items-center justify-between gap-2">
          <Text size="sm">
            Not enough {typeName} Buzz
            {clientInsufficientBuzz
              ? ` (${abbreviateNumber(selectedBalance)}/${abbreviateNumber(totalCost)})`
              : ''}
            .
            {!alternativeType && (
              <>
                {' '}
                <Text span c="blue.4" component="a" href="/purchase/buzz" target="_blank">
                  Get more Buzz
                </Text>
              </>
            )}
          </Text>
          {alternativeType && (
            <Button
              variant="light"
              color="yellow"
              radius="xl"
              size="compact-sm"
              onClick={() => {
                setBuzzType(alternativeType);
                onClearInsufficientBuzz?.();
              }}
            >
              Switch to {alternativeType.charAt(0).toUpperCase() + alternativeType.slice(1)} Buzz
            </Button>
          )}
        </div>
      </Notification>
    );
  } else if (featureFlags.enhancedCompatibilitySdcpp) {
    // Dismissal is keyed per-ecosystem via DismissibleAlert's localStorage id.
    // When enhancedCompatibility is on, the bonus doesn't apply — swap in a
    // warning (with its own dismissal key) so users know how to qualify.
    // BOGO/enhancedCompatibility only applies to txt2img.
    priorityAlert = (
      <MultiController
        graph={graph}
        names={['workflow', 'ecosystem', 'model', 'enhancedCompatibility'] as const}
        render={({ values }) => {
          const workflow = values.workflow as string | undefined;
          const ecosystem = values.ecosystem as string | undefined;
          const model = values.model as { id?: number } | undefined;
          const enhancedCompatibility = values.enhancedCompatibility as boolean | undefined;
          if (workflow !== 'txt2img') return null;
          if (!ecosystem || !SDCPP_SUPPORTED_ECOSYSTEMS.includes(ecosystem)) return null;
          if (model?.id !== undefined && SDCPP_EXCLUDED_MODEL_IDS.includes(model.id)) return null;
          if (enhancedCompatibility) {
            return (
              <DismissibleAlert
                id={`bogo-sdcpp-warn-${ecosystem}`}
                color="yellow"
                size="sm"
                title="Miss Out on 2-for-1 Bonus"
              >
                Turn off Enhanced Compatibility to get 2 images per generation for the price of 1.
              </DismissibleAlert>
            );
          }
          return (
            <DismissibleAlert
              id={`bogo-sdcpp-${ecosystem}`}
              color="blue"
              size="sm"
              title="2-for-1 Bonus Active"
            >
              Each generation produces 2 images for the price of 1 on this model.
            </DismissibleAlert>
          );
        }}
      />
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
    isLoading: isBuzzLoading,
  } = useQueryBuzz([selectedType]);
  const balance = accounts.find((a) => a.type === selectedType)?.balance ?? 0;
  const insufficientBuzz = !isBuzzLoading && totalCost > 0 && balance < totalCost;

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
      disabled={
        !running &&
        (isWhatIfLoading || isBuzzLoading || isError || !canEstimateCost || insufficientBuzz)
      }
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
// QuantityField Component
// =============================================================================

/**
 * Quantity input. The graph's quantity node sets `meta.max` to the user's
 * tier-gated cap (`ext.limits.vidQuantity` for LTXV23, `maxQuantity` elsewhere).
 *
 * For LTXV23 non-gold users (tier cap below 4), the default Mantine controls
 * are replaced with custom chevrons so the up-arrow stays interactive at the
 * cap and opens a membership upsell popover instead of being silently
 * disabled. Typing is unrestricted during input; on blur the value snaps to
 * the closest valid number, and an attempt to exceed the cap also fires the
 * popover.
 */
function QuantityField() {
  const graph = useGraph<GenerationGraphTypes>();
  // Subscribe to only `ecosystem` so prompt edits don't re-render this field.
  const { ecosystem } = useGraphSubscriptions(graph, ['ecosystem'] as const) as {
    ecosystem?: string;
  };
  const isLtxv23 = ecosystem === 'LTXV23';

  const [upsellOpened, setUpsellOpened] = useState(false);

  return (
    <Controller
      graph={graph}
      name="quantity"
      render={({ value, meta, onChange }) => (
        <QuantityFieldInner
          value={value}
          meta={meta}
          onChange={onChange}
          isLtxv23={isLtxv23}
          upsellOpened={upsellOpened}
          setUpsellOpened={setUpsellOpened}
        />
      )}
    />
  );
}

interface QuantityFieldInnerProps {
  value: number | undefined;
  meta: { min: number; max: number; step: number };
  onChange: (next: number) => void;
  isLtxv23: boolean;
  upsellOpened: boolean;
  setUpsellOpened: (open: boolean) => void;
}

function QuantityFieldInner({
  value,
  meta,
  onChange,
  isLtxv23,
  upsellOpened,
  setUpsellOpened,
}: QuantityFieldInnerProps) {
  const tierMax = meta.max;
  const min = meta.min;
  const step = meta.step ?? 1;
  const showUpsell = isLtxv23 && tierMax < LTXV23_MAX_QUANTITY;

  // Local input state — lets the user freely type any value (including
  // out-of-range) without Mantine pre-clamping or the graph schema snapping
  // mid-keystroke. We commit + snap on blur.
  const [displayValue, setDisplayValue] = useState<number | string>(value ?? min);
  useEffect(() => {
    setDisplayValue(value ?? min);
  }, [value, min]);

  const snap = (n: number) => {
    if (!Number.isFinite(n)) return min;
    const stepped = Math.round((n - min) / step) * step + min;
    return Math.max(min, Math.min(stepped, tierMax));
  };

  const commit = (next: number) => {
    const snapped = snap(next);
    if (snapped !== value) onChange(snapped);
    setDisplayValue(snapped);
    return snapped;
  };

  const handleChange = (val: number | string) => {
    setDisplayValue(val);
    // Commit valid in-range, step-aligned values immediately so whatIf
    // (which subscribes to graph changes) refetches without waiting for
    // blur. Out-of-range or partially-typed values still defer to blur,
    // which is where snapping happens.
    if (val === '' || val === undefined || val === null) return;
    const n = Number(val);
    if (!Number.isFinite(n)) return;
    if (n < min || n > tierMax) return;
    if ((n - min) % step !== 0) return;
    if (n !== value) onChange(n);
  };

  const handleBlur: React.FocusEventHandler<HTMLInputElement> = (e) => {
    const raw = e.currentTarget.value;
    if (raw === '' || !Number.isFinite(Number(raw))) {
      commit(min);
      return;
    }
    const parsed = Number(raw);
    commit(parsed);
    if (showUpsell && parsed > tierMax) setUpsellOpened(true);
  };

  const handleIncrement = () => {
    const current = value ?? min;
    if (showUpsell && current >= tierMax) {
      setUpsellOpened(true);
      return;
    }
    commit(current + step);
  };

  const handleDecrement = () => {
    const current = value ?? min;
    commit(current - step);
  };

  const card = (
    <Card withBorder className="flex max-w-[68px] flex-col p-0">
      <NumberInput
        value={displayValue}
        onChange={handleChange}
        onBlur={handleBlur}
        min={min}
        max={tierMax}
        step={step}
        clampBehavior="none"
        allowDecimal={false}
        allowNegative={false}
        hideControls={showUpsell}
        rightSection={
          showUpsell ? (
            <div className="flex flex-col items-center justify-center pr-1">
              <ActionIcon
                variant="transparent"
                size="xs"
                color="gray"
                onClick={handleIncrement}
                aria-label="Increase quantity"
                h={12}
              >
                <IconChevronUp size={12} />
              </ActionIcon>
              <ActionIcon
                variant="transparent"
                size="xs"
                color="gray"
                onClick={handleDecrement}
                disabled={(value ?? min) <= min}
                aria-label="Decrease quantity"
                h={12}
              >
                <IconChevronDown size={12} />
              </ActionIcon>
            </div>
          ) : undefined
        }
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
  );

  if (!showUpsell) return card;

  return (
    <Popover
      opened={upsellOpened}
      onChange={setUpsellOpened}
      position="top-start"
      withinPortal
      shadow="md"
      width={260}
    >
      <Popover.Target>{card}</Popover.Target>
      <Popover.Dropdown p="sm">
        <Text size="sm" fw={600} mb={4}>
          Generate more per request
        </Text>
        <Text size="xs" c="dimmed" mb="sm">
          Your current tier allows {tierMax} {tierMax === 1 ? 'video' : 'videos'} per request.
          Upgrade your membership to generate up to {LTXV23_MAX_QUANTITY} at a time.
        </Text>
        <Button
          component="a"
          href="/pricing"
          target="_blank"
          rel="noreferrer nofollow"
          size="compact-sm"
          fullWidth
        >
          Upgrade membership
        </Button>
      </Popover.Dropdown>
    </Popover>
  );
}

// =============================================================================
// BlueBuzzMatureReminder Component
// =============================================================================

/**
 * Compact reminder shown below the priority alerts once a non-member on .red has
 * acknowledged the Blue Buzz mature-content upsell (the full upsell alert in
 * GenerationLayout only renders while it still needs acknowledgment). Keeps the
 * limitation visible without re-blocking the submit footer.
 */
function BlueBuzzMatureReminder() {
  const { variant, acknowledged } = useMembershipUpsell();
  const serverDomains = useServerDomains();

  if (variant !== 'blue-on-red' || !acknowledged) return null;

  return (
    <Text size="xs" c="dimmed">
      Blue Buzz can&apos;t generate mature content without{' '}
      <Text
        span
        c="blue.4"
        className="cursor-pointer"
        component="a"
        href={syncAccount(`//${serverDomains.green}/pricing`)}
        target="_blank"
        rel="noreferrer nofollow"
      >
        a membership
      </Text>
    </Text>
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
  const { trackAction } = useTrackEvent();
  const generationContextStore = useGenerationContextStore();

  // Get validation state from whatIf context
  const { canEstimateCost, validationErrors } = useWhatIfContext();

  // Get user-friendly message if required fields are missing
  const missingFieldMessage = !canEstimateCost ? getMissingFieldMessage(validationErrors) : null;

  const [submitError, setSubmitError] = useState<string | undefined>();
  const [insufficientBuzzError, setInsufficientBuzzError] = useState(false);
  const [isMinLoading, setIsMinLoading] = useState(false);
  const minLoadingTimer = useRef<ReturnType<typeof setTimeout>>();
  const [promptWarning, setPromptWarning] = useState<string | null>(null);

  // Get whatIf data for buzz transaction checking
  const { data: whatIfData } = useWhatIfContext();

  // Resolved buzz type shown in the UI — defaults to the site's primary type
  // (e.g. green on .com) when the user hasn't explicitly picked one. Sent with
  // the mutation so the server charges the account the user sees selected,
  // instead of falling through to the orchestrator's priority-ordered list.
  const { selectedType: selectedBuzzType } = useSelectedBuzzType();

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
      } else if (error.message === 'insufficientBuzz') {
        // Route through the insufficient-buzz alert (with switch-buzz-type prompt)
        // instead of the generic submit-error notification.
        setInsufficientBuzzError(true);
      } else {
        setSubmitError(error.message ?? 'An unexpected error occurred. Please try again later.');
      }
    },
  });

  const clearWarning = () => setPromptWarning(null);

  const handleSubmit = async () => {
    // Generation funnel telemetry — ordering matches legacy GenForm semantics.
    //
    // Legacy: RHF's `onError` fires BEFORE GenForm's `canGenerate` short-
    // circuit, so a rate-limited+invalid submit collapses to isValid:false
    // (never reaches the rate-limited branch). If v2 checked canGenerate
    // first, the same case would collapse to isRateLimited:true — making
    // `isRateLimited:true AND formVersion='new'` a strict superset of
    // legacy. Run graph.validate() FIRST so the two paths agree on which
    // signal wins in the overlap case.
    //
    // The v2 form's SubmitButton wires `onClick` directly (not through
    // GenForm), so the GenForm canGenerate short-circuit never runs here —
    // we mirror it inline below after validation passes.
    //
    // Exactly ONE Generator_Submit event is emitted per click:
    //   - validation fails           → emit { isValid: false } and return
    //   - validation passes + rate-limited → emit { isValid: true, isRateLimited: true } and return
    //   - validation passes + not rate-limited → emit { isValid: true } and proceed
    const result = graph.validate();
    const fromAction = useGenerationGraphStore.getState().lastEntryAction;

    // Validation-fail branch. Pairs with the `isValid:true` emit below so the
    // data team has a complete attempt funnel. We deliberately do NOT also
    // check canGenerate here — matching legacy collapse where the validation
    // failure is the only signal emitted.
    if (!result.success) {
      try {
        const submitSnapshot = graph.getSnapshot() as ResourceSnapshot;
        trackAction({
          type: 'Generator_Submit',
          details: {
            // modelVersionId: snapshot.model is the Checkpoint resource node;
            // .id on a resource node IS ModelVersion.id, not the parent
            // Model.id. The graph snapshot field is named `model` for
            // historical reasons.
            modelVersionId: submitSnapshot.model?.id,
            fromAction,
            hasRemixOfId: !!remixOfId,
            formVersion: 'new',
            isValid: false,
          },
        }).catch(() => undefined);
      } catch {
        // Telemetry must never block a submission.
      }
      console.log('Validation failed:', result.errors);
      return;
    }

    // Rate-limited branch. Only reached when validation already passed
    // (legacy parity: RHF rejects before GenForm checks canGenerate, so
    // invalid+rate-limited collapses to isValid:false for both paths).
    // Emits isValid:true + isRateLimited:true because the submit would
    // have been valid; only the concurrent-request cap stopped it.
    // `formVersion: 'new'` keeps this discriminable from the legacy /
    // video rate-limit emits (which still emit isValid:false — they
    // pre-date this ordering pass).
    const contextSnapshot = generationContextStore.getState();
    if (!contextSnapshot.canGenerate) {
      try {
        trackAction({
          type: 'Generator_Submit',
          details: {
            fromAction,
            formVersion: 'new',
            isValid: true,
            isRateLimited: true,
          },
        }).catch(() => undefined);
      } catch {
        // Telemetry must never block UI.
      }
      showWarningNotification({
        message:
          contextSnapshot.requestsRemaining === 0
            ? `You are already generating at your limit: ${contextSnapshot.queued.length}`
            : 'Request queued. Your generation request will begin shortly.',
      });
      return;
    }

    // Happy path — validation + rate-limit both clear. Emit Generator_Submit
    // BEFORE the buzz-transaction prompt so click-and-abandon (cancel at
    // confirm / insufficient-buzz) is still captured.
    //
    // externalId is shared between this emit AND the mutateAsync input below.
    // Failure-path emits (validation, rate-limit) above omit it because no
    // orchestrator workflow exists for those rows. Generated inside the try
    // so a crypto.randomUUID() throw (non-secure-context fallback) can't
    // break the submit — externalId stays undefined and the path degrades
    // to pre-PR behavior (no idempotency, no exact-join).
    let externalId: string | undefined;
    try {
      externalId = crypto.randomUUID();
      const submitSnapshot = graph.getSnapshot() as ResourceSnapshot;
      trackAction({
        type: 'Generator_Submit',
        details: {
          modelVersionId: submitSnapshot.model?.id,
          fromAction,
          hasRemixOfId: !!remixOfId,
          formVersion: 'new',
          isValid: true,
          externalId,
        },
      }).catch(() => undefined);
    } catch {
      // Telemetry must never block a submission.
    }

    setSubmitError(undefined);
    setInsufficientBuzzError(false);
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
        tags: [WORKFLOW_TAGS.SOURCE.NEW],
        buzzType: selectedBuzzType,
        ...(sourceMetadata ? { sourceMetadata } : {}),
        ...(sourceMetadataMap ? { sourceMetadataMap } : {}),
        externalId,
      });

      if (hasEarlyAccess) {
        invalidateWhatIf();
      }

      // Clear media inputs after submit for one-shot enhancement workflows
      // (upscale, remove-bg) so they don't persist in localStorage. Iterative
      // workflows (preprocess) keep the source image so the user can try a
      // different `kind` on the same image — gated by `returnAfterSubmit`.
      const returnAfterSubmit =
        !!snapshot.workflow &&
        workflowConfigByKey.get(snapshot.workflow)?.returnAfterSubmit === true;
      if (returnAfterSubmit) {
        const clear: Record<string, unknown> = {};
        if (snapshot.images?.length) clear.images = [];
        if (snapshot.video) clear.video = undefined;
        if (Object.keys(clear).length > 0) {
          (graph as { set: (v: Record<string, unknown>) => void }).set(clear);
        }
      }

      // Drop any preview-locked snippets seed so the next submission samples
      // fresh values. The seed is only ever set by the wildcard preview modal
      // (so the user can reroll deterministically within a preview session)
      // and is never persisted to workflow metadata — leaving it in the
      // graph after submit would silently pin every subsequent generation to
      // the same wildcard expansion.
      const submitSnap = graph.getSnapshot() as { snippets?: { seed?: number } };
      if (submitSnap.snippets?.seed !== undefined) {
        const { seed: _seed, ...rest } = submitSnap.snippets;
        (graph as { set: (v: Record<string, unknown>) => void }).set({ snippets: rest });
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
        forceInsufficientBuzz={insufficientBuzzError}
        onClearInsufficientBuzz={() => setInsufficientBuzzError(false)}
      />

      <BlueBuzzMatureReminder />

      {!membershipUpsell.needsAcknowledgment && (
        <div className="flex h-[52px] items-stretch gap-2">
          <QuantityField />
          <Button.Group className="flex-1">
            <SubmitButton
              isLoading={generateMutation.isPending || isMinLoading}
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
