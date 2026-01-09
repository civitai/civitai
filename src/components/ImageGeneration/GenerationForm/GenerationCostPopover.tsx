import type { TransactionInfo, WorkflowCost } from '@civitai/client';
import type { PopoverProps } from '@mantine/core';
import { Group, NumberInput, Popover, Text } from '@mantine/core';
import { openModal } from '@mantine/modals';
import { IconInfoCircle } from '@tabler/icons-react';
import React from 'react';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import type { Props as DescriptionTableProps } from '~/components/DescriptionTable/DescriptionTable';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { Currency } from '~/shared/utils/prisma/enums';
import { useTipStore } from '~/store/tip.store';
import classes from './GenerationCostPopover.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { buzzSpendTypes } from '~/shared/constants/buzz.constants';
import { useMainBuzzAccountType, useQueryBuzz } from '~/components/Buzz/useBuzz';
import { getBuzzTypeDistribution } from '~/utils/buzz';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';

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

  // When no transactions are available, we use the cost to determine the badge color.
  const availableBuzzTypes = useAvailableBuzz(['blue']);
  const guessedMainBuzzAccountType = useMainBuzzAccountType(availableBuzzTypes, totalCost);
  const mainBuzzAccountType =
    transactions && transactions.length > 0
      ? transactions.reduce((highest, current) =>
          current.amount > highest.amount ? current : highest
        ).accountType
      : guessedMainBuzzAccountType;

  return (
    <Popover shadow="md" {...popoverProps} withinPortal>
      <Popover.Target>
        {variant === 'info-circle' ? (
          <LegacyActionIcon
            variant="subtle"
            size="xs"
            color="yellow.7"
            radius="xl"
            disabled={disabled}
          >
            <IconInfoCircle stroke={2.5} />
          </LegacyActionIcon>
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

function GenerationCostPopoverDetail({
  workflowCost,
  readOnly,
  disabled,
  hideCreatorTip,
  hideCivitaiTip,
  buzzAccountType,
}: Props) {
  const { civitaiTip, creatorTip } = useTipStore((state) => ({
    creatorTip: state.creatorTip * 100,
    civitaiTip: state.civitaiTip * 100,
  }));

  const handleShowExplanationClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();

    openModal({
      title: 'Generation Cost Breakdown',
      centered: true,
      children: <BreakdownExplanation />,
    });
  };

  const baseCost = workflowCost.base ?? 0;

  const items: DescriptionTableProps['items'] = [
    {
      label: 'Quantity',
      value: <Text align="right">{Math.ceil(workflowCost.factors?.quantity ?? 0)}x</Text>,
      visible: !!workflowCost.factors?.quantity && workflowCost.factors?.quantity > 1,
      className: classes.tableCell,
    },
    {
      label: 'Size',
      value: <Text align="right">{Math.ceil(workflowCost.factors?.size ?? 0)}x</Text>,
      visible: !!workflowCost.factors?.size && workflowCost.factors?.size > 1,
      className: classes.tableCell,
    },
    {
      label: 'Steps',
      value: (
        <Text align="right">{Math.round(((workflowCost.factors?.steps ?? 0) - 1) * 100)}%</Text>
      ),
      visible: !!workflowCost.factors?.steps && workflowCost.factors?.steps !== 1,
      className: classes.tableCell,
    },
    {
      label: 'Sampler',
      value: (
        <Text align="right">{Math.round(((workflowCost.factors?.scheduler ?? 0) - 1) * 100)}%</Text>
      ),
      visible: !!workflowCost.factors?.scheduler && workflowCost.factors?.scheduler !== 1,
      className: classes.tableCell,
    },
    {
      label: 'Popularity',
      value: (
        <Text align="right">
          {Math.round(((workflowCost.factors?.popularity ?? 0) - 1) * 100)}%
        </Text>
      ),
      visible: !!workflowCost.factors?.popularity && workflowCost.factors?.popularity !== 1,
      className: classes.tableCell,
    },
    {
      label: <div className="font-bold">Base Cost</div>,
      value: (
        <Group gap={4} justify="flex-end" className="font-bold" wrap="nowrap">
          {baseCost ?? '0'}
          <CurrencyIcon currency="BUZZ" size={16} type={buzzAccountType} />
        </Group>
      ),
      className: clsx(classes.tableCell, classes.baseCostCell),
    },
    {
      label: 'Additional Resource Cost',
      value: (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {workflowCost.fixed?.additionalNetworks}
          <CurrencyIcon currency="BUZZ" size={16} type={buzzAccountType} />
        </Group>
      ),
      visible: !!workflowCost.fixed?.additionalNetworks,
      className: classes.tableCell,
    },
    {
      label: 'Priority Pricing',
      value: (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {workflowCost.fixed?.priority}
          <CurrencyIcon currency="BUZZ" size={16} type={buzzAccountType} />
        </Group>
      ),
      visible: !!workflowCost.fixed?.priority,
      className: classes.tableCell,
    },
    {
      label: 'Output Format',
      value: (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {workflowCost.fixed?.format}
          <CurrencyIcon currency="BUZZ" size={16} type={buzzAccountType} />
        </Group>
      ),
      visible: !!workflowCost.fixed?.format,
      className: classes.tableCell,
    },
    {
      label: (
        <div className="flex items-center justify-between">
          Creator Tip{' '}
          <NumberInput
            value={creatorTip}
            onChange={(value = 0) => useTipStore.setState({ creatorTip: Number(value) / 100 })}
            min={0}
            max={100}
            w={110}
            step={5}
            classNames={{ input: 'pr-[30px] text-end' }}
            leftSection={getEmojiByValue(creatorTip)}
            suffix="%"
            allowDecimal={false}
          />
        </div>
      ),
      value: (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {`${Math.ceil((baseCost * creatorTip) / 100)}`}
          <CurrencyIcon currency="BUZZ" size={16} type={buzzAccountType} />
        </Group>
      ),
      visible: !readOnly && !hideCreatorTip,
      className: classes.tableCell,
    },
    {
      label: 'Creator Tip',
      value: (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {`${workflowCost.tips?.creators}`}
          <CurrencyIcon currency="BUZZ" size={16} type={buzzAccountType} />
        </Group>
      ),
      visible: !!readOnly && !!workflowCost.tips?.creators,
      className: classes.tableCell,
    },
    {
      label: (
        <div className="flex items-center justify-between">
          Civitai Tip{' '}
          <NumberInput
            value={civitaiTip}
            onChange={(value = 0) => useTipStore.setState({ civitaiTip: Number(value) / 100 })}
            min={0}
            max={100}
            w={110}
            step={5}
            defaultValue={0}
            classNames={{ input: 'pr-[30px] text-end' }}
            leftSection={getEmojiByValue(civitaiTip ?? 0)}
            suffix="%"
            allowDecimal={false}
          />
        </div>
      ),
      value: (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {`${Math.ceil((baseCost * civitaiTip) / 100)}`}
          <CurrencyIcon currency="BUZZ" size={16} type={buzzAccountType} />
        </Group>
      ),
      visible: !readOnly && !hideCivitaiTip,
      className: classes.tableCell,
    },
    {
      label: 'Civitai Tip',
      value: (
        <Group gap={4} justify="flex-end" wrap="nowrap">
          {workflowCost.tips?.civitai ?? '0'}
          <CurrencyIcon currency="BUZZ" size={16} type={buzzAccountType} />
        </Group>
      ),
      visible: !!readOnly && !!workflowCost.tips?.civitai,
      className: classes.tableCell,
    },
  ];

  return (
    <DescriptionTable
      title={
        <div className={clsx(classes.baseCostCell, 'flex items-center justify-between gap-4 p-2')}>
          <div className="font-semibold">Generation Cost Breakdown</div>
          <LegacyActionIcon variant="subtle" radius="xl" onClick={handleShowExplanationClick}>
            <IconInfoCircle size={18} />
          </LegacyActionIcon>
        </div>
      }
      items={items}
      withBorder={false}
    />
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
