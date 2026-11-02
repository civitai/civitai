import type { WorkflowCost } from '@civitai/orchestration-client';
import { Button, Text, UnstyledButton } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconMinus,
  IconPlus,
  IconRestore,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { useEffect, useState } from 'react';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';
import { useSelectedBuzzType } from '~/components/Generation/footer-parts';
import { PopoverOrSheet } from '~/components/generation_v2/PopoverOrSheet';
import { GenerationCostPopoverDetail } from '~/components/ImageGeneration/GenerationForm/GenerationCostPopover';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { Currency } from '~/shared/utils/prisma/enums';
import { useTipStore } from '~/store/tip.store';
import { numberWithCommas } from '~/utils/number-helpers';

const SEEN_KEY = 'buzz-type-selector-seen';

/**
 * The generator's Buzz button, showing the cost and opening everything about it. A popover on
 * desktop, a sheet on a phone.
 */
export function CostPicker({
  cost,
  workflowCost,
  loading,
  error,
  unavailable,
  onRetry,
  showCreatorTip,
  showCivitaiTip,
  tourTarget,
}: {
  /** The total, tips included. */
  cost: number;
  workflowCost: WorkflowCost;
  loading: boolean;
  error: boolean;
  /** No estimate can be requested yet: a dash, not a spinner that waits for the form to change. */
  unavailable: boolean;
  onRetry: () => void;
  showCreatorTip: boolean;
  showCivitaiTip: boolean;
  tourTarget?: string;
}) {
  const [opened, setOpened] = useState(false);
  const { availableTypes, selectedType, setBuzzType } = useSelectedBuzzType();
  const { colorRgb } = useBuzzCurrencyConfig(selectedType);
  const {
    data: { accounts },
    isLoading: balanceLoading,
  } = useQueryBuzz(availableTypes);

  // The button glows until first opened, so people find where the Buzz type is chosen.
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(SEEN_KEY)) setGlow(true);
    } catch {}
  }, []);
  // A toggle: on desktop the button stays clickable under its open popover.
  const toggle = () => {
    setOpened((value) => !value);
    if (!glow) return;
    setGlow(false);
    try {
      localStorage.setItem(SEEN_KEY, '1');
    } catch {}
  };

  if (error)
    return (
      <Button
        data-tour={tourTarget}
        variant="default"
        color="red"
        className="h-full px-3"
        aria-label="Cost estimate failed. Retry"
        onClick={onRetry}
      >
        <IconAlertTriangle size={16} />
        <IconRestore size={16} />
      </Button>
    );

  const balance = accounts.find((account) => account.type === selectedType)?.balance ?? 0;

  return (
    <PopoverOrSheet
      opened={opened}
      onClose={() => setOpened(false)}
      title="Cost for this run"
      popoverProps={{ position: 'top-end', width: 340 }}
      target={
        <Button
          data-tour={tourTarget}
          variant="default"
          className={clsx('h-full gap-1 px-2', glow && 'animate-buzz-glow')}
          style={glow ? ({ '--buzz-color': colorRgb } as CSSProperties) : undefined}
          loading={loading || (!unavailable && cost <= 0)}
          loaderProps={{ size: 14 }}
          aria-label="Cost and Buzz type"
          onClick={toggle}
        >
          <CurrencyIcon currency={Currency.BUZZ} type={selectedType} size={16} />
          <Text span size="sm" fw={700} className="tabular-nums">
            {unavailable ? '–' : numberWithCommas(cost)}
          </Text>
          <IconChevronDown size={14} className="ml-0.5 text-gray-6" />
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <Text fw={600}>Total</Text>
          <Text fw={700} size="xl" className="flex items-center gap-1 tabular-nums">
            <CurrencyIcon currency={Currency.BUZZ} type={selectedType} size={18} />
            {unavailable ? '–' : numberWithCommas(cost)}
          </Text>
        </div>

        {(showCreatorTip || showCivitaiTip) && (
          <div className="flex flex-col gap-1">
            <Text size="xs" fw={700} c="dimmed" tt="uppercase">
              Tips, included in the total
            </Text>
            {showCreatorTip && (
              <TipStepper
                label="Creator tip"
                description="Goes to the creators of the resources you use"
                tip="creatorTip"
              />
            )}
            {showCivitaiTip && (
              <TipStepper label="Civitai tip" description="Goes to Civitai" tip="civitaiTip" />
            )}
          </div>
        )}

        <div className="flex flex-col gap-1">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase">
            Pay with
          </Text>
          <div role="radiogroup" aria-label="Pay with" className="flex flex-col">
            {availableTypes.map((type) => {
              const typeBalance = accounts.find((account) => account.type === type)?.balance ?? 0;
              const checked = type === selectedType;
              return (
                <UnstyledButton
                  key={type}
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setBuzzType(type)}
                  className={clsx(
                    'flex min-h-12 items-center gap-3 rounded-md px-3',
                    checked
                      ? 'bg-gray-1 dark:bg-dark-5'
                      : 'hover:bg-gray-0 active:bg-gray-1 dark:hover:bg-dark-6 dark:active:bg-dark-6'
                  )}
                >
                  <CurrencyIcon currency={Currency.BUZZ} type={type} size={18} />
                  <span className="flex-1 capitalize">{type} Buzz</span>
                  <span className="tabular-nums text-gray-6 dark:text-dark-2">
                    {numberWithCommas(typeBalance)}
                  </span>
                  <IconCheck size={18} className={clsx(!checked && 'invisible', 'text-blue-6')} />
                </UnstyledButton>
              );
            })}
          </div>
          {!unavailable && !balanceLoading && cost > 0 && (
            <Text size="sm" c={balance < cost ? 'red' : 'dimmed'}>
              {balance < cost
                ? `Not enough: ${numberWithCommas(cost - balance)} more needed`
                : `Balance after this run: ${numberWithCommas(balance - cost)}`}
            </Text>
          )}
        </div>

        <HowItIsCalculated workflowCost={workflowCost} />
      </div>
    </PopoverOrSheet>
  );
}

function HowItIsCalculated({ workflowCost }: { workflowCost: WorkflowCost }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="rounded-md border border-gray-3 dark:border-dark-4">
      <UnstyledButton
        aria-expanded={shown}
        onClick={() => setShown((value) => !value)}
        className="flex min-h-12 w-full items-center justify-between px-3"
      >
        <span>How this is calculated</span>
        <IconChevronDown
          size={16}
          className={clsx('transition-transform', shown && 'rotate-180')}
        />
      </UnstyledButton>
      {shown && (
        // The tips are above, so the breakdown is the cost before them.
        <GenerationCostPopoverDetail
          workflowCost={workflowCost}
          hideCreatorTip
          hideCivitaiTip
          withTotal={false}
        />
      )}
    </div>
  );
}

const TIP_STEP = 5;

function TipStepper({
  label,
  description,
  tip,
}: {
  label: string;
  description: string;
  tip: 'creatorTip' | 'civitaiTip';
}) {
  const percent = Math.round(useTipStore((state) => state[tip]) * 100);
  const set = (next: number) =>
    useTipStore.setState({ [tip]: Math.max(0, Math.min(100, next)) / 100 });
  return (
    <div className="flex min-h-12 items-center gap-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{label}</span>
        <Text span size="xs" c="dimmed">
          {description}
        </Text>
      </span>
      <LegacyActionIcon
        variant="default"
        size="lg"
        aria-label={`Lower the ${label.toLowerCase()}`}
        disabled={percent <= 0}
        onClick={() => set(percent - TIP_STEP)}
      >
        <IconMinus size={16} />
      </LegacyActionIcon>
      <span className="w-12 text-center font-semibold tabular-nums">{percent}%</span>
      <LegacyActionIcon
        variant="default"
        size="lg"
        aria-label={`Raise the ${label.toLowerCase()}`}
        disabled={percent >= 100}
        onClick={() => set(percent + TIP_STEP)}
      >
        <IconPlus size={16} />
      </LegacyActionIcon>
    </div>
  );
}
