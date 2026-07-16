import type { TransactionInfo, WorkflowCost } from '@civitai/client';
import type { PopoverProps } from '@mantine/core';
import { Anchor, Group, Loader, NumberInput, Popover, Text } from '@mantine/core';
import { openModal } from '@mantine/modals';
import { IconInfoCircle } from '@tabler/icons-react';
import React, { useEffect, useState } from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Currency } from '~/shared/utils/prisma/enums';
import { useTipStore } from '~/store/tip.store';
import classes from './GenerationCostPopover.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { useGenerationFormStore } from '~/store/generation-form.store';
import { startCase } from 'lodash-es';
import { formatToLeastDecimals } from '~/utils/number-helpers';
import { parseAIRSafe } from '~/shared/utils/air';
import { getModelUrl } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const getEmojiByValue = (value: number) => {
  if (value === 0) return '😢';
  if (value < 5) return '🙂';
  if (value < 15) return '😃';
  if (value < 20) return '😁';
  if (value < 35) return '😍';
  return '😇';
};

export function GenerationCostPopover({
  workflowCost,
  readOnly,
  hideCreatorTip,
  hideCivitaiTip,
  variant = 'info-circle',
  transactions,
  ...popoverProps
}: Omit<PopoverProps, 'children'> & Props) {
  const totalCost = workflowCost.total ?? 0;
  const disabled = totalCost > 0 ? popoverProps.disabled : true;

  // Use the user-selected buzz type for the cost badge color
  const availableBuzzTypes = useAvailableBuzz(['blue']);
  const storedBuzzType = useGenerationFormStore((s) => s.buzzType);
  const selectedType =
    storedBuzzType && availableBuzzTypes.includes(storedBuzzType)
      ? storedBuzzType
      : availableBuzzTypes.find((t) => t !== 'blue') ?? availableBuzzTypes[0];
  const mainBuzzAccountType =
    transactions && transactions.length > 0
      ? transactions.reduce((highest, current) =>
          current.amount > highest.amount ? current : highest
        ).accountType
      : selectedType;

  return (
    <Popover shadow="md" {...popoverProps} withinPortal>
      <Popover.Target>
        {variant === 'info-circle' ? (
          <div className="flex cursor-pointer items-center gap-1">
            <Text span c="yellow.7" size="sm">
              Breakdown
            </Text>
            <Text span c="yellow.7" size="sm">
              <IconInfoCircle size="16" stroke={2.5} />
            </Text>
          </div>
        ) : (
          <CurrencyBadge
            unitAmount={totalCost}
            currency={Currency.BUZZ}
            size="xs"
            className="cursor-pointer"
            type={mainBuzzAccountType as BuzzSpendType}
          />
        )}
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <GenerationCostPopoverDetail
          workflowCost={workflowCost}
          readOnly={readOnly}
          disabled={disabled}
          hideCreatorTip={hideCreatorTip}
          hideCivitaiTip={hideCivitaiTip}
          buzzAccountType={mainBuzzAccountType as BuzzSpendType}
        />
      </Popover.Dropdown>
    </Popover>
  );
}

const fixedPricingDictionary = new Map<string, string>([
  ['priority', 'Priority Pricing'],
  ['format', 'Output Format'],
  ['additionalNetworks', 'Additional Resource Cost'],
]);

const factorRowConfig: {
  key: string;
  label: string;
  format: (value: number) => string;
  visible: (value: number) => boolean;
}[] = [
  { key: 'quantity', label: 'Quantity', format: (v) => `${Math.ceil(v)}x`, visible: (v) => v > 1 },
  { key: 'size', label: 'Size', format: (v) => `${Math.ceil(v)}x`, visible: (v) => v > 1 },
  {
    key: 'steps',
    label: 'Steps',
    format: (v) => `${Math.round((v - 1) * 100)}%`,
    visible: (v) => v !== 1,
  },
  {
    key: 'scheduler',
    label: 'Sampler',
    format: (v) => `${Math.round((v - 1) * 100)}%`,
    visible: (v) => v !== 1,
  },
  {
    key: 'popularity',
    label: 'Popularity',
    format: (v) => `${Math.round((v - 1) * 100)}%`,
    visible: (v) => v !== 1,
  },
];

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <div className={classes.sectionHeader}>{children}</div>;
}

function CostRow({
  label,
  value,
  variant = 'default',
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  variant?: 'default' | 'subtotal' | 'total';
}) {
  return (
    <div
      className={clsx(
        classes.row,
        variant === 'subtotal' && classes.subtotalRow,
        variant === 'total' && classes.totalRow
      )}
    >
      <div className={classes.label}>{label}</div>
      <div className={classes.value}>{value}</div>
    </div>
  );
}

const tipInputProps = {
  min: 0,
  max: 100,
  w: 104,
  step: 5,
  size: 'xs' as const,
  classNames: { input: 'pr-[28px] text-end' },
  suffix: '%',
  allowDecimal: false,
};

/**
 * Tip percentage input. Keeps its own string display so an emptied field snaps
 * back to "0" instead of rendering blank — Mantine's NumberInput drops a numeric
 * 0, and the tip store bails on same-value writes, so neither reliably re-renders
 * "0" on its own.
 */
function TipInput({ percent, onChange }: { percent: number; onChange: (value: number) => void }) {
  const [display, setDisplay] = useState(String(percent));

  useEffect(() => {
    setDisplay(String(percent));
  }, [percent]);

  const handleChange = (value: number | string) => {
    const str = value === '' || value == null ? '0' : String(value);
    setDisplay(str);
    const num = Number(str);
    onChange(Number.isFinite(num) ? num : 0);
  };

  return (
    <NumberInput
      value={display}
      onChange={handleChange}
      leftSection={getEmojiByValue(Number(display) || 0)}
      {...tipInputProps}
    />
  );
}

function BuzzValue({ amount, type }: { amount: number | string; type?: BuzzSpendType }) {
  return (
    <Group gap={4} justify="flex-end" wrap="nowrap">
      {`${typeof amount === 'number' ? formatToLeastDecimals(amount) : amount}`}
      <CurrencyIcon currency="BUZZ" size={14} type={type} />
    </Group>
  );
}

function GenerationCostPopoverDetail({
  workflowCost,
  readOnly,
  hideCreatorTip,
  hideCivitaiTip,
  buzzAccountType,
}: Props) {
  const { creatorTip, civitaiTip } = useTipStore((state) => ({
    creatorTip: state.creatorTip * 100,
    civitaiTip: state.civitaiTip * 100,
  }));

  const handleCreatorTipChange = (value: number | string = 0) => {
    const num = Number(value);
    useTipStore.setState({ creatorTip: (Number.isFinite(num) ? num : 0) / 100 });
  };

  const handleCivitaiTipChange = (value: number | string = 0) => {
    const num = Number(value);
    useTipStore.setState({ civitaiTip: (Number.isFinite(num) ? num : 0) / 100 });
  };

  const handleShowExplanationClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();

    openModal({
      title: 'Generation Cost Breakdown',
      centered: true,
      children: <BreakdownExplanation />,
    });
  };

  const factors: Record<string, number> = workflowCost.factors ?? {};
  const baseCost = workflowCost.base ?? 0;
  const bulkDiscount = factors.bulkDiscount ?? factors['bulk discount'] ?? 1;

  const factorRows = factorRowConfig
    .filter(({ key, visible }) => factors[key] != null && visible(factors[key]))
    .map(({ key, label, format }) => ({ label, value: format(factors[key]) }));
  if (bulkDiscount !== 1)
    factorRows.push({ label: 'Bulk Discount', value: `${Math.round((bulkDiscount - 1) * 100)}%` });

  const fixedFees = Object.entries(workflowCost.fixed ?? {}).filter(([, value]) => value !== 0);
  const licensingFees = Object.values(workflowCost.fees ?? {}).reduce((sum, fee) => sum + fee, 0);
  const hasAdditionalFees = fixedFees.length > 0 || licensingFees > 0;

  const creatorTipAmount = readOnly
    ? workflowCost.tips?.creators ?? 0
    : Math.ceil((baseCost * creatorTip) / 100);
  const civitaiTipAmount = readOnly
    ? workflowCost.tips?.civitai ?? 0
    : Math.ceil((baseCost * civitaiTip) / 100);

  // readOnly is a receipt — hide any tip that ended up 0. The editable form always
  // shows the tip rows (unless explicitly hidden) so 0 renders and can be adjusted.
  const showCreatorTip = readOnly ? creatorTipAmount > 0 : !hideCreatorTip;
  const showCivitaiTip = readOnly ? civitaiTipAmount > 0 : !hideCivitaiTip;
  const hasTips = showCreatorTip || showCivitaiTip;

  // whatIf `total` excludes tips (added client-side); a completed workflow's
  // `total` already includes them.
  const grandTotal = readOnly
    ? workflowCost.total ?? 0
    : (workflowCost.total ?? 0) + creatorTipAmount + civitaiTipAmount;

  return (
    <div className={classes.table}>
      <div className={classes.header}>
        <span>Generation Cost Breakdown</span>
        <LegacyActionIcon variant="subtle" radius="xl" onClick={handleShowExplanationClick}>
          <IconInfoCircle size={18} />
        </LegacyActionIcon>
      </div>

      <SectionHeader>Base Cost</SectionHeader>
      {factorRows.map((row) => (
        <CostRow
          key={row.label}
          label={row.label}
          value={<span className={classes.factorValue}>{row.value}</span>}
        />
      ))}
      <CostRow
        variant="subtotal"
        label="Base Cost"
        value={<BuzzValue amount={baseCost} type={buzzAccountType} />}
      />

      {hasAdditionalFees && (
        <>
          <SectionHeader>Additional Fees</SectionHeader>
          {fixedFees.map(([key, value]) => (
            <CostRow
              key={key}
              label={fixedPricingDictionary.get(key) ?? startCase(key)}
              value={<BuzzValue amount={value} type={buzzAccountType} />}
            />
          ))}
          {licensingFees > 0 && (
            <CostRow
              label={
                <div className="flex items-center gap-1">
                  <span>Licensing Fees</span>
                  <LegacyActionIcon
                    variant="subtle"
                    size="xs"
                    radius="xl"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openModal({
                        title: 'Licensing Fees',
                        centered: true,
                        children: (
                          <LicensingFeeDetail
                            fees={workflowCost.fees ?? {}}
                            quantity={factors.quantity ?? 1}
                            type={buzzAccountType}
                          />
                        ),
                      });
                    }}
                  >
                    <IconInfoCircle size={14} />
                  </LegacyActionIcon>
                </div>
              }
              value={<BuzzValue amount={licensingFees} type={buzzAccountType} />}
            />
          )}
        </>
      )}

      {hasTips && (
        <>
          <SectionHeader>Tips</SectionHeader>
          {showCreatorTip && (
            <CostRow
              label={
                <div className="flex items-center justify-between gap-2">
                  <span>Creator Tip</span>
                  {!readOnly && <TipInput percent={creatorTip} onChange={handleCreatorTipChange} />}
                </div>
              }
              value={<BuzzValue amount={creatorTipAmount} type={buzzAccountType} />}
            />
          )}
          {showCivitaiTip && (
            <CostRow
              label={
                <div className="flex items-center justify-between gap-2">
                  <span>Civitai Tip</span>
                  {!readOnly && <TipInput percent={civitaiTip} onChange={handleCivitaiTipChange} />}
                </div>
              }
              value={<BuzzValue amount={civitaiTipAmount} type={buzzAccountType} />}
            />
          )}
        </>
      )}

      <CostRow
        variant="total"
        label="Total"
        value={<BuzzValue amount={grandTotal} type={buzzAccountType} />}
      />
    </div>
  );
}

function BreakdownExplanation() {
  return (
    <ul className="m-0 list-none pr-4 text-sm">
      <li className="mb-2">
        <span className="font-semibold">Base Cost:</span>
        {` The base cost of generating an image is
        ⚡1 for 512x512 at 30 steps with a basic sampler. Flux's base cost is currently driven by
        our underlying provider. We'll continue to improve this as we onboard additional providers.`}
      </li>
      <li className="mb-2">
        <span className="font-semibold">Size Multiplier:</span> Based on the size difference between
        what you&apos;re requesting and the base resolution for your image, we charge a Size
        Multiplier. For example SDXL at 1024x1024 will have a multiplier of 4x.
      </li>
      <li className="mb-2">
        <span className="font-semibold">Step Multiplier:</span> Basic generations cover 30 steps, if
        you do more or less than that, the amount you are charged is adjusted accordingly.
      </li>
      <li className="mb-2">
        <span className="font-semibold">Sampler Multiplier:</span> Some samplers cause generation to
        take more time and because of that increase the total cost of generating.
      </li>
      {/* <li className="mb-2">
        <span className="font-semibold">Workflow Cost:</span> Some workflows cost extra because they
        take extra time to run on our hardware.
      </li> */}
      <li className="mb-2">
        <span className="font-semibold">Licensing Fees:</span> Some resources charge a per-image
        licensing fee set by their creator. When you use one, its fee is added to the cost and paid
        to the resource&apos;s creator. This total is the sum of the fees for every resource in your
        request.
      </li>
      <li className="mb-2">
        <span className="font-semibold">Creator Tip:</span> Show appreciation to the creator of the
        resources that you&apos;re using by including a tip. All tips go directly to the creators of
        the resources you use for generating. To show our appreciation to creators, this starts at
        25% but you can set it to whatever you think is right.
      </li>
      <li className="mb-2">
        <span className="font-semibold">Civitai Tip:</span> Love Civitai and want to show extra
        appreciation? Include a tip for us 😍
      </li>
    </ul>
  );
}

/**
 * Per-resource licensing fee breakdown. The whatIf `fees` dict is keyed by resource
 * AIR with the total charged for that resource across the whole request; we parse
 * each to its version id, batch-fetch the resources for their model/version name,
 * and show the per-image cost (charged ÷ quantity, so the rows stay consistent with
 * the aggregate). Rows without a resolvable resource fall back to the raw AIR.
 */
function LicensingFeeDetail({
  fees,
  quantity,
  type,
}: {
  fees: Record<string, number>;
  quantity: number;
  type?: BuzzSpendType;
}) {
  const entries = Object.entries(fees);
  const versionIds = entries
    .map(([air]) => parseAIRSafe(air)?.version)
    .filter((v): v is number => typeof v === 'number');

  const { data: versions, isLoading } = trpc.modelVersion.getVersionsByIds.useQuery(
    { ids: versionIds },
    { enabled: versionIds.length > 0 }
  );

  const byId = new Map((versions ?? []).map((v) => [v.id, v]));
  const perImageDivisor = quantity > 0 ? quantity : 1;

  return (
    <div className="flex flex-col gap-3">
      <Text size="sm" c="dimmed">
        Some resources charge a licensing fee set by their creator, paid to them each time you
        generate an image with the resource. The amounts below are per image — your total scales with
        the number of images you generate.
      </Text>
      {isLoading ? (
        <div className="flex justify-center p-4">
          <Loader size="sm" />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {entries.map(([air, amount]) => {
            const versionId = parseAIRSafe(air)?.version;
            const version = versionId != null ? byId.get(versionId) : undefined;
            const url = version
              ? getModelUrl({
                  modelId: version.modelId,
                  modelName: version.modelName,
                  modelVersionId: version.id,
                })
              : undefined;
            return (
              <div key={air} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  {url ? (
                    <Anchor
                      href={url}
                      target="_blank"
                      size="sm"
                      fw={590}
                      className="block truncate"
                    >
                      {version!.modelName}
                    </Anchor>
                  ) : (
                    <Text size="sm" fw={590} className="truncate">
                      {air}
                    </Text>
                  )}
                  {version?.name && (
                    <Text size="xs" c="dimmed" className="truncate">
                      {version.name}
                    </Text>
                  )}
                </div>
                <Group gap={4} wrap="nowrap" className="shrink-0">
                  <BuzzValue amount={amount / perImageDivisor} type={type} />
                  <Text size="xs" c="dimmed">
                    / image
                  </Text>
                </Group>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

type Props = {
  workflowCost: WorkflowCost;
  readOnly?: boolean;
  disabled?: boolean;
  hideCreatorTip?: boolean;
  hideCivitaiTip?: boolean;
  variant?: 'info-circle' | 'badge';
  buzzAccountType?: BuzzSpendType;
  transactions?: TransactionInfo[];
};
