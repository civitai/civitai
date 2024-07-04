import {
  ActionIcon,
  Group,
  NumberInput,
  NumberInputProps,
  Popover,
  PopoverProps,
  Text,
} from '@mantine/core';
import { openModal } from '@mantine/modals';
import { IconInfoCircle } from '@tabler/icons-react';
import React from 'react';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';

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
  creatorTipInputOptions,
  civitaiTipInputOptions,
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

  const items = [
    { label: 'Base Cost', value: <Text align="end">24 ⚡️</Text> },
    { label: 'Size Cost', value: <Text align="end">24 ⚡️</Text> },
    { label: 'Step Cost', value: <Text align="end">24 ⚡️</Text> },
    { label: 'Workflow Cost', value: <Text align="end">24 ⚡️</Text> },
    {
      label: (
        <Group position="apart">
          Creator Tip{' '}
          <NumberInput
            {...creatorTipInputOptions}
            min={0}
            max={100}
            w={100}
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
      value: <Text align="end">24 ⚡️</Text>,
    },
    {
      label: (
        <Group position="apart">
          Civitai Tip{' '}
          <NumberInput
            {...civitaiTipInputOptions}
            min={0}
            max={100}
            w={100}
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
      value: <Text align="end">24 ⚡️</Text>,
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
  creatorTipInputOptions: Pick<NumberInputProps, 'value' | 'onChange'>;
  civitaiTipInputOptions: Pick<NumberInputProps, 'value' | 'onChange'>;
};
