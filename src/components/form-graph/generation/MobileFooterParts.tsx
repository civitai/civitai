import { Text, UnstyledButton } from '@mantine/core';
import { IconLock, IconRestore } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { PopoverOrSheet } from '~/components/generation_v2/PopoverOrSheet';
import { TitleActions } from '~/components/ImageGeneration/mobile-generator-slots';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export function QuantityPicker({
  value,
  min,
  max,
  step,
  upsellMax,
  onChange,
}: {
  value: number;
  min: number;
  /** The tier's limit. */
  max: number;
  step: number;
  /** A higher limit a membership upgrade unlocks, shown locked. */
  upsellMax?: number;
  onChange: (value: number) => void;
}) {
  const [opened, setOpened] = useState(false);
  const values: number[] = [];
  for (let n = min; n <= (upsellMax ?? max); n += step) values.push(n);

  return (
    <PopoverOrSheet
      opened={opened}
      onClose={() => setOpened(false)}
      title="Quantity"
      target={
        <UnstyledButton
          aria-label={`Quantity: ${value}`}
          onClick={() => setOpened(true)}
          className="flex w-[68px] shrink-0 flex-col items-center justify-center gap-1 rounded-md border border-gray-3 bg-white leading-none active:bg-gray-1 dark:border-dark-4 dark:bg-dark-6 dark:active:bg-dark-5"
        >
          <span className="text-xl font-bold tabular-nums">{value}</span>
          <span className="text-[10px] font-bold tracking-wider text-gray-6 dark:text-dark-2">
            QTY
          </span>
        </UnstyledButton>
      }
    >
      <div className="grid grid-cols-4 gap-2">
        {values.map((n) => {
          const locked = n > max;
          const selected = n === value;
          return (
            <UnstyledButton
              key={n}
              disabled={locked}
              aria-pressed={selected}
              onClick={() => {
                if (n !== value) onChange(n);
                setOpened(false);
              }}
              className={clsx(
                'flex h-12 items-center justify-center gap-1 rounded-md border text-lg font-semibold tabular-nums',
                selected
                  ? 'border-blue-6 bg-blue-6 text-white'
                  : 'border-gray-3 dark:border-dark-4',
                locked && 'opacity-50'
              )}
            >
              {locked && <IconLock size={14} />}
              {n}
            </UnstyledButton>
          );
        })}
      </div>
      {upsellMax && upsellMax > max && (
        <Text size="sm" c="dimmed" mt="md">
          Your tier allows {max} per request.{' '}
          <Text component="a" href="/pricing" target="_blank" c="blue.4" inherit>
            Upgrade your membership
          </Text>{' '}
          to generate up to {upsellMax} at a time.
        </Text>
      )}
    </PopoverOrSheet>
  );
}

/** Reset, in the open sheet's title row. */
export function TitleRowReset({ onReset }: { onReset: () => void }) {
  return (
    <TitleActions>
      <LegacyActionIcon
        aria-label="Reset"
        variant="subtle"
        color="gray"
        size="lg"
        onClick={onReset}
      >
        <IconRestore size={20} />
      </LegacyActionIcon>
    </TitleActions>
  );
}
