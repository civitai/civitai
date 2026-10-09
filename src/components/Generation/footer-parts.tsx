/**
 * Footer pieces with no dependency on the form engine: the Buzz type selector, the metadata
 * extraction footer and the step-warnings notification.
 */

import { Button, LoadingOverlay, Menu, Notification, Text, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowRight,
  IconArrowsShuffle,
  IconChevronDown,
  IconDots,
  IconRestore,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { Currency } from '~/shared/utils/prisma/enums';
import { useGenerationFormStore } from '~/store/generation-form.store';
import { numberWithCommas } from '~/utils/number-helpers';
import {
  getEcosystemsForWorkflow,
  isWorkflowAvailable,
} from '~/shared/generation/config/workflows';
import { ecosystemByKey } from '~/shared/constants/basemodel.constants';
import {
  openCompatibilityConfirmModal,
  buildWorkflowPendingChange,
} from '~/components/generation_v2/CompatibilityConfirmModal';
import { workflowPreferences } from '~/store/workflow-preferences.store';
import { useMetadataExtractionStore } from '~/store/metadata-extraction.store';
import { useGeneratedItemWorkflows } from '~/components/generation_v2/hooks/useGeneratedItemWorkflows';
import { generationGraphStore, REMIX_WORKFLOW_OVERRIDES } from '~/store/generation-graph.store';
import { Alert } from '@mantine/core';
import { pickStrongerGate, rulesToStates, type GateResolution } from '~/shared/generation/gates';
import { useGenerationConfig } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useGenerationFormValue } from '~/components/Generate/useGenerationFormBridge';
import { useServerDomains } from '~/providers/AppProvider';
import { useSyncAccount } from '~/hooks/useSyncAccount';

const BUZZ_SELECTOR_SEEN_KEY = 'buzz-type-selector-seen';
const PRIMARY_WORKFLOW_KEYS = ['txt2img', 'img2img', 'img2img:edit'];
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

export function StepWarningsNotification({ warnings }: { warnings: { message: string }[] }) {
  return (
    <Notification
      icon={<IconAlertTriangle size={18} />}
      color="yellow"
      className="whitespace-pre-wrap rounded-md bg-yellow-8/20"
      withCloseButton={false}
    >
      {warnings.map((warning) => warning.message).join('\n')}
    </Notification>
  );
}

export function BuzzTypeSelector({
  cost,
  loading,
  error,
  unavailable,
  onRetry,
  tourTarget,
}: {
  cost: number;
  loading: boolean;
  error?: boolean;
  /**
   * No estimate can be requested yet (e.g. the form is invalid): show a dash rather than treating a
   * zero cost as "still loading", which spins until the form changes. `loading` still wins, so an
   * upload that will make the form valid keeps the spinner.
   */
  unavailable?: boolean;
  onRetry?: () => void;
  /** `data-tour` for the cost button. Only the generator's tour spotlights it. */
  tourTarget?: string;
}) {
  const { availableTypes, selectedType, setBuzzType } = useSelectedBuzzType();
  const buzzConfig = useBuzzCurrencyConfig(selectedType);
  const {
    data: { accounts },
  } = useQueryBuzz(availableTypes);

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

  const lastCostRef = useRef(0);
  if (totalCost > 0) lastCostRef.current = totalCost;
  const displayCost = isWhatIfLoading ? lastCostRef.current : totalCost;
  const showLoading = !error && (isWhatIfLoading || (!unavailable && displayCost <= 0));

  if (error && onRetry) {
    return (
      <Tooltip label="Failed to estimate cost. Click to retry.">
        <Button
          data-tour={tourTarget}
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
          data-tour={tourTarget}
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
            {unavailable ? '–' : numberWithCommas(displayCost)}
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

  const isAliasWorkflow = (w: { id: string; graphKey: string }) => w.id !== w.graphKey;
  const imageWorkflows = (groups.find((g) => g.category === 'image')?.workflows ?? []).filter(
    (w) => !w.enhancement && !isAliasWorkflow(w) && w.graphKey !== 'img2meta'
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
      params.images = [{ url: fileUrl }];
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

    if (isStandalone) {
      applyToForm(workflowKey, undefined, opts);
      return;
    }

    const ecosystemId = ecosystemKey ? ecosystemByKey.get(ecosystemKey)?.id : undefined;
    const compatible = ecosystemId != null && isWorkflowAvailable(workflowKey, ecosystemId);

    if (compatible) {
      applyToForm(workflowKey, ecosystemKey, opts);
      return;
    }

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
  // Subscribe to only `ecosystem` — not the whole form — so prompt/seed/etc.
  // edits don't needlessly re-render this.
  const selectedEcosystem = useGenerationFormValue<string>('ecosystem');
  if (!selectedEcosystem)
    return { blockedEcosystem: undefined, state: undefined, message: undefined };

  let resolution: GateResolution | undefined;
  if (selfHostedDisabledEcosystems.includes(selectedEcosystem))
    resolution = pickStrongerGate(resolution, {
      state: selfHostedMode === 'memberOnly' ? 'memberOnly' : 'disabled',
    });
  // Rule-`disabled` is deliberately absent: it must not take over the footer or
  // hide the form controls. It reports itself in the form body instead, and
  // blocks whatIf + submit through `useDisabledGates`.
  const ruleRes = rulesToStates(gateRules).ecosystems.get(selectedEcosystem);
  if (ruleRes && ruleRes.state === 'memberOnly') resolution = pickStrongerGate(resolution, ruleRes);

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
  const syncAccount = useSyncAccount();

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
