import { Group, Popover, Text, UnstyledButton } from '@mantine/core';
import { IconBolt, IconCheck, IconChevronDown } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { getBuzzCurrencyConfig } from '~/shared/constants/currency.constants';

export type PayWithOption = 'default' | 'blue-first';

const Bolt = ({ type }: { type: BuzzSpendType }) => {
  const { color } = getBuzzCurrencyConfig(type);
  return <IconBolt size={16} color={color} fill={color} className="shrink-0" />;
};

// Payment picker for blue-accepting shop items: the domain color alone, or
// blue first with the rest in the domain color. A compact select-style trigger
// that opens a dropdown, so it takes a single row in the purchase modal.
export function PayWithSelector({
  value,
  onChange,
  domainType,
}: {
  value: PayWithOption;
  onChange: (value: PayWithOption) => void;
  domainType: BuzzSpendType;
}) {
  const [opened, setOpened] = useState(false);
  const domainLabel = domainType === 'green' ? 'Green' : 'Yellow';
  const domainColor = getBuzzCurrencyConfig(domainType).color;
  const blueColor = getBuzzCurrencyConfig('blue').color;
  const wash = (color: string) => `color-mix(in srgb, ${color} 14%, transparent)`;

  const options: {
    value: PayWithOption;
    label: string;
    caption: string;
    bolts: BuzzSpendType[];
    background: string;
  }[] = [
    {
      value: 'default',
      label: `${domainLabel} Buzz`,
      caption: `Pay the full price in ${domainLabel}`,
      bolts: [domainType],
      background: wash(domainColor),
    },
    {
      value: 'blue-first',
      label: `Blue + ${domainLabel}`,
      caption: `Use your Blue first, the rest in ${domainLabel}`,
      bolts: ['blue', domainType],
      background: `linear-gradient(90deg, ${wash(blueColor)}, ${wash(domainColor)})`,
    },
  ];
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width="target"
      position="bottom"
      radius="md"
      shadow="md"
    >
      <Popover.Target>
        <UnstyledButton
          onClick={() => setOpened((o) => !o)}
          aria-label="Choose how to pay"
          className="w-full rounded-md border border-solid border-gray-3 px-3 py-2 transition-colors hover:bg-gray-0 dark:border-dark-4 dark:hover:bg-dark-5"
        >
          <Group gap={8} wrap="nowrap" justify="space-between">
            <Group gap={8} wrap="nowrap">
              <Text size="xs" c="dimmed" className="shrink-0">
                Pay with
              </Text>
              <Group gap={2} wrap="nowrap">
                {selected.bolts.map((type) => (
                  <Bolt key={type} type={type} />
                ))}
              </Group>
              <Text size="sm" fw={500} lh={1.3} truncate>
                {selected.label}
              </Text>
            </Group>
            <IconChevronDown
              size={16}
              className={clsx('shrink-0 transition-transform', opened && 'rotate-180')}
            />
          </Group>
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown p={4}>
        <div className="flex flex-col gap-1">
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <UnstyledButton
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpened(false);
                }}
                aria-pressed={isSelected}
                className="rounded-md px-2 py-1.5 transition-colors hover:bg-gray-1 dark:hover:bg-dark-5"
                style={isSelected ? { background: option.background } : undefined}
              >
                <Group gap={8} wrap="nowrap">
                  <Group gap={2} wrap="nowrap">
                    {option.bolts.map((type) => (
                      <Bolt key={type} type={type} />
                    ))}
                  </Group>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <Text size="sm" fw={isSelected ? 600 : 500} lh={1.3}>
                      {option.label}
                    </Text>
                    <Text size="xs" c="dimmed" lh={1.3}>
                      {option.caption}
                    </Text>
                  </div>
                  {isSelected && <IconCheck size={16} className="shrink-0 text-green-500" />}
                </Group>
              </UnstyledButton>
            );
          })}
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}
