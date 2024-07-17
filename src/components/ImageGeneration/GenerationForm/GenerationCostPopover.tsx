import {
  ActionIcon,
  Group,
  NumberInput,
  NumberInputProps,
  Popover,
  PopoverProps,
} from '@mantine/core';
import { openModal } from '@mantine/modals';
import { IconInfoCircle } from '@tabler/icons-react';
import React from 'react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import {
  DescriptionTable,
  Props as DescriptionTableProps,
} from '~/components/DescriptionTable/DescriptionTable';

const getEmojiByValue = (value: number) => {
  if (value === 0) return '😢';
  if (value < 5) return '🙂';
  if (value < 15) return '😃';
  if (value < 20) return '😁';
  if (value < 35) return '😍';
  return '😇';
};

export function GenerationCostPopover({
  children,
  baseCost,
  creatorTipInputOptions,
  civitaiTipInputOptions,
  readOnly,
  ...popoverProps
}: Props) {
  const handleShowExplanationClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    e.preventDefault();
    e.stopPropagation();

    openModal({
      title: 'Generation Cost Breakdown',
      centered: true,
      children: <BreakdownExplanation />,
    });
  };

  const items: DescriptionTableProps['items'] = [
    {
      label: 'Base Cost',
      value: (
        <Group spacing={4} position="right" noWrap>
          {baseCost}
          <CurrencyIcon currency="BUZZ" size={16} />
        </Group>
      ),
    },
    {
      label: 'Size Cost',
      value: (
        <Group spacing={4} position="right" noWrap>
          {baseCost}
          <CurrencyIcon currency="BUZZ" size={16} />
        </Group>
      ),
    },
    {
      label: 'Step Cost',
      value: (
        <Group spacing={4} position="right" noWrap>
          {baseCost}
          <CurrencyIcon currency="BUZZ" size={16} />
        </Group>
      ),
    },
    {
      label: 'Workflow Cost',
      value: (
        <Group spacing={4} position="right" noWrap>
          {baseCost}
          <CurrencyIcon currency="BUZZ" size={16} />
        </Group>
      ),
    },
    {
      label: <div className="font-semibold">Total</div>,
      value: (
        <Group spacing={4} position="right" noWrap>
          {baseCost}
          <CurrencyIcon currency="BUZZ" size={16} />
        </Group>
      ),
      visible: !readOnly,
    },
    {
      label: (
        <Group position="apart">
          Creator Tip{' '}
          <NumberInput
            {...creatorTipInputOptions}
            min={0}
            max={100}
            w={110}
            step={5}
            defaultValue={0}
            classNames={{ input: 'pr-[30px] text-end' }}
            icon={getEmojiByValue(creatorTipInputOptions?.value ?? 0)}
            formatter={(value) => {
              if (!value) return '0%';
              const parsedValue = parseFloat(value);

              return !Number.isNaN(parsedValue) ? `${parsedValue}%` : '0%';
            }}
          />
        </Group>
      ),
      value: (
        <Group spacing={4} position="right" noWrap>
          {Math.ceil((baseCost * (creatorTipInputOptions?.value ?? 0)) / 100)}
          <CurrencyIcon currency="BUZZ" size={16} />
        </Group>
      ),
      visible: !readOnly,
    },
    {
      label: 'Creator Tip',
      value: (
        <Group spacing={4} position="right" noWrap>
          {baseCost}
          <CurrencyIcon currency="BUZZ" size={16} />
        </Group>
      ),
      visible: !!readOnly,
    },
    {
      label: (
        <Group position="apart">
          Civitai Tip{' '}
          <NumberInput
            {...civitaiTipInputOptions}
            min={0}
            max={100}
            w={110}
            step={5}
            defaultValue={0}
            classNames={{ input: 'pr-[30px] text-end' }}
            formatter={(value) => {
              if (!value) return '%';
              const parsedValue = parseFloat(value);

              return !Number.isNaN(parsedValue) ? `${parsedValue}%` : '%';
            }}
          />
        </Group>
      ),
      value: (
        <Group spacing={4} position="right" noWrap>
          {Math.ceil((baseCost * (civitaiTipInputOptions?.value ?? 0)) / 100)}
          <CurrencyIcon currency="BUZZ" size={16} />
        </Group>
      ),
      visible: !readOnly,
    },
    {
      label: 'Civitai Tip',
      value: (
        <Group spacing={4} position="right" noWrap>
          {baseCost}
          <CurrencyIcon currency="BUZZ" size={16} />
        </Group>
      ),
      visible: !!readOnly,
    },
  ];

  return (
    <Popover {...popoverProps}>
      <Popover.Target>{children}</Popover.Target>
      <Popover.Dropdown p={0}>
        <DescriptionTable
          title={
            <div className="flex items-center justify-between gap-4 p-2">
              <div className="font-semibold">Generation Cost Breakdown</div>
              <ActionIcon variant="subtle" radius="xl" onClick={handleShowExplanationClick}>
                <IconInfoCircle size={18} />
              </ActionIcon>
            </div>
          }
          items={items}
          withBorder={false}
        />
      </Popover.Dropdown>
    </Popover>
  );
}

function BreakdownExplanation() {
  return (
    <ul className="list-inside list-none text-sm">
      <li className="mb-2">
        <span className="font-semibold">Base Cost:</span> The base cost of generating an image with
        the selected model. SDXL has a base cost of ⚡4 and SD1.5 has a base cost of ⚡1.
      </li>
      <li className="mb-2">
        <span className="font-semibold">Size Cost:</span> Based on the size difference between what
        you&apos;re requesting and the base resolution for your image, we charge a Size Cost. The
        base size of SDXL is 1024x1024 and for SD1.5 it&apos;s 512x512.
      </li>
      <li className="mb-2">
        <span className="font-semibold">Step Cost:</span> Basic generations cover 25 steps, if you
        do more or less than that, the amount you are charged is adjusted accordingly
      </li>
      <li className="mb-2">
        <span className="font-semibold">Workflow Cost:</span> Some workflows cost extra because they
        take extra time to run on our hardware.
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

type Props = PopoverProps & {
  baseCost: number;
  creatorTipInputOptions?: Pick<NumberInputProps, 'value' | 'onChange'>;
  civitaiTipInputOptions?: Pick<NumberInputProps, 'value' | 'onChange'>;
  readOnly?: boolean;
};
