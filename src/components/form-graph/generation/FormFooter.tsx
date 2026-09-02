/**
 * Submit footer for the form-graph lane — parity port of generation_v2's
 * `FormFooter` on the form-graph store: quantity input, submit button with
 * buzz-type selector, reset, priority alerts (missing fields, whatIf errors,
 * submit errors, insufficient buzz, BOGO), queue snackbar, prompt-block
 * handling, telemetry, and license attribution. The buzz selector and its
 * hooks are graph-free and imported from the v1 footer rather than copied.
 */

import {
  ActionIcon,
  Alert,
  Button,
  Card,
  NumberInput,
  Popover,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconRestore,
  IconX,
} from '@tabler/icons-react';
import { Notification } from '@mantine/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Controller, MultiController } from 'form-graph/react';

import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { GenerationCostPopover } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import {
  useGenerationContext,
  useGenerationContextStore,
} from '~/components/ImageGeneration/GenerationProvider';
import { useMembershipUpsell } from '~/components/ImageGeneration/MembershipUpsell';
import { useServerDomains } from '~/providers/AppProvider';
import { useSyncAccount } from '~/hooks/useSyncAccount';
import { QueueSnackbar } from '~/components/ImageGeneration/QueueSnackbar';
import { GenerateButton } from '~/components/Orchestrator/components/GenerateButton';
import { GEN_BUZZ_KEY, GEN_SUBMIT_KEY, GEN_SUBMIT_TARGET } from '~/components/Tours/tour-targets';
import { useTourContext } from '~/components/Tours/ToursProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import {
  useGenerateFromGraph,
  useInvalidateWhatIf,
} from '~/components/ImageGeneration/utils/generationRequestHooks';
import { BuzzTypeSelector, useSelectedBuzzType } from '~/components/generation_v2/FormFooter';
import { ExperimentalAlerts } from '~/components/generation_v2/Experimental';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { useResourceDataContext } from '~/components/generation_v2/inputs/ResourceDataProvider';
import { filterSnapshotForSubmit } from '~/components/generation_v2/utils';
import { useRemixOfId } from '~/components/generation_v2/hooks/useRemixOfId';
import { workflowConfigByKey } from '~/shared/data-graph/generation/config/workflows';
import {
  ecosystemByKey,
  getBaseModelLicense,
  getBaseModelsByEcosystemId,
} from '~/shared/constants/basemodel.constants';
import {
  SDCPP_EXCLUDED_MODEL_IDS,
  SDCPP_SUPPORTED_ECOSYSTEMS,
  VID_MAX_QUANTITY,
  VID_QUANTITY_ECOSYSTEMS,
  WORKFLOW_TAGS,
} from '~/shared/constants/generation.constants';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { generationHub } from '~/shared/form-graph/generation/hub.graph';
import { outputResetPredicate } from '~/shared/form-graph/generation/reset';
import { sourceMetadataStore, type SourceMetadata } from '~/store/source-metadata.store';
import { remixStore } from '~/store/remix.store';
import { useGenerationGraphStore } from '~/store/generation-graph.store';
import { useTipStore } from '~/store/tip.store';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { showWarningNotification } from '~/utils/notifications';
import { abbreviateNumber, numberWithCommas } from '~/utils/number-helpers';

import { getMissingFieldMessage, useWhatIfContext } from './WhatIfProvider';
import type { GenerationStore } from './store';

// =============================================================================
// Cost (including tips)
// =============================================================================

interface ResourceSnapshot {
  model?: { id: number };
  resources?: { id: number }[];
  vae?: { id: number };
}

/** Creator tips apply when any user-created resource is selected. */
function getHasCreatorTip(snapshot: ResourceSnapshot): boolean {
  const { model, resources, vae } = snapshot;
  return !!(model?.id || (resources && resources.length > 0) || vae?.id);
}

function useTotalGenerationCost(store: GenerationStore) {
  const features = useFeatureFlags();
  const { creatorTip, civitaiTip } = useTipStore();
  const { data } = useWhatIfContext();

  const snapshot = store.getSnapshot().state as ResourceSnapshot;
  const hasCreatorTip = getHasCreatorTip(snapshot);

  const creatorTipRate = features.creatorComp && hasCreatorTip ? creatorTip : 0;
  const civitaiTipRate = features.creatorComp ? civitaiTip : 0;
  const base = data?.cost?.base ?? 0;
  const totalTip = Math.ceil(base * creatorTipRate) + Math.ceil(base * civitaiTipRate);

  return (data?.cost?.total ?? 0) + totalTip;
}

function ConnectedBuzzTypeSelector({ store }: { store: GenerationStore }) {
  const { isLoading, isError, refetch } = useWhatIfContext();
  const cost = useTotalGenerationCost(store);
  return (
    <BuzzTypeSelector
      cost={cost}
      loading={isLoading}
      error={isError}
      onRetry={() => refetch()}
      tourTarget={GEN_BUZZ_KEY}
    />
  );
}

// =============================================================================
// Priority alerts
// =============================================================================

function PriorityAlertSpace({
  store,
  submitError,
  onClearSubmitError,
  missingFieldMessage,
  snackbarRight,
  forceInsufficientBuzz,
  onClearInsufficientBuzz,
}: {
  store: GenerationStore;
  submitError?: string;
  onClearSubmitError: () => void;
  missingFieldMessage?: string | null;
  snackbarRight?: ReactNode;
  forceInsufficientBuzz?: boolean;
  onClearInsufficientBuzz?: () => void;
}) {
  const { error: whatIfError, isError: hasWhatIfError } = useWhatIfContext();
  const { selectedType, availableTypes, setBuzzType } = useSelectedBuzzType();
  const {
    data: { accounts },
    isLoading: isBuzzLoading,
  } = useQueryBuzz(availableTypes);
  const totalCost = useTotalGenerationCost(store);
  const featureFlags = useFeatureFlags();

  const selectedBalance = accounts.find((a) => a.type === selectedType)?.balance ?? 0;
  const clientInsufficientBuzz = !isBuzzLoading && totalCost > 0 && selectedBalance < totalCost;
  const insufficientBuzz = clientInsufficientBuzz || !!forceInsufficientBuzz;

  const alternativeType = insufficientBuzz
    ? availableTypes.find((t) => {
        if (t === selectedType) return false;
        const balance = accounts.find((a) => a.type === t)?.balance ?? 0;
        return balance >= totalCost;
      })
    : undefined;

  let priorityAlert: ReactNode;
  if (missingFieldMessage) {
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
    priorityAlert = (
      <MultiController
        graph={generationHub}
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
      <ExperimentalWarnings />
      {priorityAlert}
    </>
  );
}

/** Several can show at once, so these stay out of the exclusive chain above. */
function ExperimentalWarnings() {
  return (
    <MultiController
      graph={generationHub}
      names={['ecosystem', 'workflow', 'model', 'resources', 'vae'] as const}
      render={({ values }) => <ExperimentalAlerts selection={values} />}
    />
  );
}

// =============================================================================
// Submit button
// =============================================================================

function SubmitButton({
  store,
  isLoading: isSubmitting,
  onSubmit,
}: {
  store: GenerationStore;
  isLoading?: boolean;
  onSubmit?: () => void;
}) {
  const { running, helpers, setBlockedTarget } = useTourContext();
  const { selectedType } = useSelectedBuzzType();
  const { color } = useBuzzCurrencyConfig(selectedType);

  const { isError, isLoading: isWhatIfLoading, canEstimateCost } = useWhatIfContext();
  const totalCost = useTotalGenerationCost(store);

  const {
    data: { accounts },
    isLoading: isBuzzLoading,
  } = useQueryBuzz([selectedType]);
  const balance = accounts.find((a) => a.type === selectedType)?.balance ?? 0;
  const insufficientBuzz = !isBuzzLoading && totalCost > 0 && balance < totalCost;
  const canGenerate = useGenerationContext((state) => state.canGenerate);

  const submitBlocked =
    !canGenerate ||
    isWhatIfLoading ||
    isBuzzLoading ||
    isError ||
    !canEstimateCost ||
    insufficientBuzz;

  useEffect(() => {
    setBlockedTarget(running && submitBlocked ? GEN_SUBMIT_TARGET : null);
    return () => setBlockedTarget(null);
  }, [running, submitBlocked, setBlockedTarget]);

  const handleClick = () => {
    if (running) helpers?.next();
    onSubmit?.();
  };

  return (
    <GenerateButton
      type="button"
      data-tour={GEN_SUBMIT_KEY}
      className="h-full flex-1 px-2"
      color={color}
      loading={isSubmitting}
      disabled={submitBlocked}
      onClick={handleClick}
    />
  );
}

function CostBreakdown({ store }: { store: GenerationStore }) {
  const features = useFeatureFlags();
  const { data } = useWhatIfContext();

  if (!features.creatorComp) return null;

  const snapshot = store.getSnapshot().state as ResourceSnapshot;
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
// Quantity
// =============================================================================

function QuantityField() {
  const [upsellOpened, setUpsellOpened] = useState(false);
  return (
    <MultiController
      graph={generationHub}
      names={['ecosystem', 'quantity'] as const}
      render={({ values }) => {
        const ecosystem = values.ecosystem as string | undefined;
        const batchesVideos = !!ecosystem && VID_QUANTITY_ECOSYSTEMS.has(ecosystem);
        return (
          <Controller
            graph={generationHub}
            name="quantity"
            render={({ value, meta, onChange }) => (
              <QuantityFieldInner
                value={value}
                meta={meta ?? { min: 1, max: 4, step: 1 }}
                onChange={onChange}
                batchesVideos={batchesVideos}
                upsellOpened={upsellOpened}
                setUpsellOpened={setUpsellOpened}
              />
            )}
          />
        );
      }}
    />
  );
}

function QuantityFieldInner({
  value,
  meta,
  onChange,
  batchesVideos,
  upsellOpened,
  setUpsellOpened,
}: {
  value: number | undefined;
  meta: { min: number; max: number; step?: number };
  onChange: (next: number) => void;
  batchesVideos: boolean;
  upsellOpened: boolean;
  setUpsellOpened: (open: boolean) => void;
}) {
  const tierMax = meta.max;
  const min = meta.min;
  const step = meta.step ?? 1;
  const showUpsell = batchesVideos && tierMax < VID_MAX_QUANTITY;

  // local input state — the user types freely; commit + snap on blur
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

  const handleDecrement = () => commit((value ?? min) - step);

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
          Upgrade your membership to generate up to {VID_MAX_QUANTITY} at a time.
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

/**
 * Compact reminder once a non-member on .red has acknowledged the Blue Buzz
 * mature-content upsell — keeps the limitation visible without re-blocking
 * the submit footer.
 */
function BlueBuzzMatureReminder() {
  const { variant, acknowledged } = useMembershipUpsell();
  const serverDomains = useServerDomains();
  const syncAccount = useSyncAccount();

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
// Attribution
// =============================================================================

/** Licences that oblige naming the model in the product's own UI. */
function EcosystemAttribution() {
  return (
    <Controller
      graph={generationHub}
      name="ecosystem"
      render={({ value: ecosystem }) => {
        const ecosystemId = ecosystem ? ecosystemByKey.get(ecosystem)?.id : undefined;
        const license =
          ecosystemId == null
            ? undefined
            : getBaseModelsByEcosystemId(ecosystemId)
                .map((baseModel) => getBaseModelLicense(baseModel.id))
                .find((found) => !!found?.attribution);
        if (!license?.attribution) return null;
        return (
          <Text size="xs" ta="center">
            {license.attribution}
            {license.url && (
              <>
                {' · '}
                <Text
                  component="a"
                  href={license.url}
                  target="_blank"
                  rel="noreferrer"
                  td="underline"
                  inherit
                >
                  License
                </Text>
              </>
            )}
          </Text>
        );
      }}
    />
  );
}

// =============================================================================
// FormFooter
// =============================================================================

export function FormFooter({
  store,
  onSubmitSuccess,
}: {
  store: GenerationStore;
  onSubmitSuccess?: () => void;
}) {
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

  const { canEstimateCost, validationErrors, data: whatIfData } = useWhatIfContext();
  const missingFieldMessage = !canEstimateCost ? getMissingFieldMessage(validationErrors) : null;

  const [submitError, setSubmitError] = useState<string | undefined>();
  const [insufficientBuzzError, setInsufficientBuzzError] = useState(false);
  const [isMinLoading, setIsMinLoading] = useState(false);
  const minLoadingTimer = useRef<ReturnType<typeof setTimeout>>();
  const [promptWarning, setPromptWarning] = useState<{ message: string; soft: boolean } | null>(
    null
  );

  const { selectedType: selectedBuzzType } = useSelectedBuzzType();

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
      const soft = (error.data as { softBlock?: boolean } | undefined)?.softBlock === true;
      const message = error.message;
      const isPromptBlock =
        message?.startsWith('Your prompt was flagged') || message?.includes('POI');
      if (isPromptBlock) {
        setPromptWarning({ message, soft });
        currentUser?.refresh();
      } else if (error.message === 'insufficientBuzz') {
        setInsufficientBuzzError(true);
      } else {
        setSubmitError(error.message ?? 'An unexpected error occurred. Please try again later.');
      }
    },
  });

  const clearWarning = () => setPromptWarning(null);

  const handleSubmit = async (acknowledgedSoftBlock = false) => {
    // One Generator_Submit event per click; validate FIRST so the invalid +
    // rate-limited overlap collapses to isValid:false, matching the v1 footer
    // (see generation_v2/FormFooter.tsx for the full ordering rationale)
    const result = store.validate();
    const fromAction = useGenerationGraphStore.getState().lastEntryAction;

    if (!result.success) {
      try {
        const submitSnapshot = store.getSnapshot().state as ResourceSnapshot;
        trackAction({
          type: 'Generator_Submit',
          details: {
            modelVersionId: submitSnapshot.model?.id,
            fromAction,
            hasRemixOfId: !!remixOfId,
            formVersion: 'form-graph',
            isValid: false,
          },
        }).catch(() => undefined);
      } catch {
        // telemetry must never block a submission
      }
      return;
    }

    const contextSnapshot = generationContextStore.getState();
    if (!contextSnapshot.canGenerate) {
      try {
        trackAction({
          type: 'Generator_Submit',
          details: { fromAction, formVersion: 'form-graph', isValid: true, isRateLimited: true },
        }).catch(() => undefined);
      } catch {
        // telemetry must never block UI
      }
      showWarningNotification({
        message:
          contextSnapshot.requestsRemaining === 0
            ? `You are already generating at your limit: ${contextSnapshot.queued.length}`
            : 'Request queued. Your generation request will begin shortly.',
      });
      return;
    }

    let externalId: string | undefined;
    try {
      externalId = crypto.randomUUID();
      const submitSnapshot = store.getSnapshot().state as ResourceSnapshot;
      trackAction({
        type: 'Generator_Submit',
        details: {
          modelVersionId: submitSnapshot.model?.id,
          fromAction,
          hasRemixOfId: !!remixOfId,
          formVersion: 'form-graph',
          isValid: true,
          externalId,
        },
      }).catch(() => undefined);
    } catch {
      // telemetry must never block a submission
    }

    setSubmitError(undefined);
    setInsufficientBuzzError(false);
    setPromptWarning(null);

    clearTimeout(minLoadingTimer.current);
    setIsMinLoading(true);
    minLoadingTimer.current = setTimeout(() => setIsMinLoading(false), 1000);

    const inputData = filterSnapshotForSubmit(result.data as Record<string, unknown>, {
      computedKeys: store.getComputedKeys(),
    });

    // The wire schema strips `canGenerate`, so re-check against the resource
    // data store: drop resources the user can't actually use (v1 filters
    // these off the snapshot, where the flag is still present)
    if (Array.isArray(inputData.resources)) {
      const usable = new Set(resourceData.filter((r) => r.canGenerate !== false).map((r) => r.id));
      inputData.resources = (inputData.resources as { id: number }[]).filter(
        (r) => usable.has(r.id) || !resourceData.some((d) => d.id === r.id)
      );
    }

    const snapshot = store.getSnapshot().state as ResourceSnapshot & {
      workflow?: string;
      images?: Array<{ url: string }>;
      video?: { url: string };
      snippets?: { seed?: number };
    };
    const hasCreatorTip = getHasCreatorTip(snapshot);

    const needsSourceMetadata = snapshot.workflow
      ? workflowConfigByKey.get(snapshot.workflow)?.enhancement === true
      : false;

    let sourceMetadata: SourceMetadata | undefined;
    let sourceMetadataMap: Record<string, SourceMetadata> | undefined;
    if (needsSourceMetadata) {
      const images = snapshot.images;
      const mediaUrl = images?.[0]?.url || snapshot.video?.url;
      if (mediaUrl) sourceMetadata = sourceMetadataStore.getMetadata(mediaUrl);
      if (images && images.length > 1) {
        sourceMetadataMap = {};
        for (const img of images) {
          const meta = sourceMetadataStore.getMetadata(img.url);
          if (meta) sourceMetadataMap[img.url] = meta;
        }
      }
    }

    const creatorTipRate = features.creatorComp && hasCreatorTip ? creatorTip : 0;
    const civitaiTipRate = features.creatorComp ? civitaiTip : 0;
    const base = whatIfData?.cost?.base ?? 0;
    const totalTip = Math.ceil(base * creatorTipRate) + Math.ceil(base * civitaiTipRate);
    const totalCost = (whatIfData?.cost?.total ?? 0) + totalTip;

    const hasPaidAccess = resourceData.some((x) => x.paidAccess);

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
        acknowledgedSoftBlock,
      });

      if (hasPaidAccess) invalidateWhatIf();

      // one-shot enhancement workflows clear their media after submit
      const returnAfterSubmit =
        !!snapshot.workflow &&
        workflowConfigByKey.get(snapshot.workflow)?.returnAfterSubmit === true;
      if (returnAfterSubmit) {
        const clear: Record<string, unknown> = {};
        if (snapshot.images?.length) clear.images = [];
        if (snapshot.video) clear.video = undefined;
        if (Object.keys(clear).length > 0) store.set(clear);
      }

      // drop any preview-locked snippets seed so the next submission samples
      // fresh wildcard values
      if (snapshot.snippets?.seed !== undefined) {
        const { seed: _seed, ...rest } = snapshot.snippets;
        store.set({ snippets: rest });
      }

      onSubmitSuccess?.();
    };

    conditionalPerformTransaction(totalCost, performTransaction);
  };

  const handleReset = () => {
    const snap = store.getSnapshot().state as { output?: string };
    const outputType = (snap.output ?? 'image') as 'image' | 'video' | 'audio' | 'model3d';

    // clear only THIS output's buckets (v1's clearStorageForOutput semantics)
    // while preserving output preferences; other outputs' settings survive
    store.prune(outputResetPredicate(outputType, { exclude: ['outputFormat', 'priority'] }));

    if (outputType === 'video') store.set({ workflow: 'txt2vid' });
    if (outputType === 'audio') store.set({ workflow: 'txt2music' });
    if (outputType === 'model3d') store.set({ workflow: 'txt2model3d' });

    remixStore.clearRemix();
    clearWarning();
    setSubmitError(undefined);
  };

  if (promptWarning) {
    return (
      <>
        <Alert
          color={promptWarning.soft ? 'yellow' : 'red'}
          title={promptWarning.soft ? 'Prompt Flagged' : 'Prohibited Prompt'}
        >
          <Text className="whitespace-pre-wrap">{promptWarning.message}</Text>
          {promptWarning.soft && (
            <Text size="sm" mt={4}>
              Our filter can misread ordinary wording. If you know your prompt follows our content
              policy, you can generate it anyway.
            </Text>
          )}
          <Button
            color={promptWarning.soft ? 'yellow' : 'red'}
            variant="light"
            onClick={() => {
              clearWarning();
              if (promptWarning.soft) handleSubmit(true);
            }}
            style={{ marginTop: 10 }}
            leftSection={<IconCheck />}
            fullWidth
          >
            {promptWarning.soft ? 'Generate Anyway' : 'I Understand, Continue Generating'}
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
        store={store}
        submitError={submitError}
        onClearSubmitError={() => setSubmitError(undefined)}
        missingFieldMessage={missingFieldMessage}
        snackbarRight={<CostBreakdown store={store} />}
        forceInsufficientBuzz={insufficientBuzzError}
        onClearInsufficientBuzz={() => setInsufficientBuzzError(false)}
      />

      <BlueBuzzMatureReminder />

      {!membershipUpsell.needsAcknowledgment && (
        <div className="flex h-[52px] items-stretch gap-2">
          <QuantityField />
          <Button.Group className="flex-1">
            <SubmitButton
              store={store}
              isLoading={generateMutation.isPending || isMinLoading}
              onSubmit={handleSubmit}
            />
            {currentUser && <ConnectedBuzzTypeSelector store={store} />}
          </Button.Group>
          <Tooltip label="Reset">
            <ActionIcon onClick={handleReset} variant="default" className="h-auto" size="xl">
              <IconRestore size={16} />
            </ActionIcon>
          </Tooltip>
        </div>
      )}

      <EcosystemAttribution />
    </>
  );
}
