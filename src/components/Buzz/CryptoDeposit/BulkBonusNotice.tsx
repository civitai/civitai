import { Group, Stack, Text } from '@mantine/core';
import { IconArrowRight, IconTrendingUp } from '@tabler/icons-react';
import { openBulkBonusInfo } from '~/components/Dialog/triggers/bulk-bonus-info';
import { buzzBulkBonusMultipliers } from '~/server/common/constants';
import { numberWithCommas } from '~/utils/number-helpers';

type Props = {
  /** Symbol for the currently selected fiat, e.g. "$", "€" */
  fiatSymbol: string;
  /** Fiat per 1000 Buzz (same as the conversion rate shown above) */
  buzzPrice: number | null;
};

function formatFiat(buzz: number, buzzPrice: number | null, symbol: string) {
  if (buzzPrice == null) {
    return `$${numberWithCommas(Math.round(buzz / 1000))}`;
  }
  const value = (buzz / 1000) * buzzPrice;
  return `${symbol}${numberWithCommas(Math.round(value))}`;
}

export function BulkBonusNotice({ fiatSymbol, buzzPrice }: Props) {
  return (
    <Stack gap={6}>
      <Group gap={6} justify="space-between" wrap="nowrap">
        <Group gap={6} wrap="nowrap">
          <IconTrendingUp size={14} className="text-blue-500 dark:text-blue-400" />
          <Text size="xs" fw={700} c="blue.4" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
            Bulk Bonus
          </Text>
        </Group>
        <button
          type="button"
          onClick={openBulkBonusInfo}
          className="flex items-center gap-0.5 text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          <span>View Details</span>
          <IconArrowRight size={12} />
        </button>
      </Group>
      <Text size="xs" c="dimmed" lh={1.4}>
        Larger deposits earn bonus Blue Buzz, automatically.
      </Text>
      <Group gap={6} wrap="nowrap">
        {buzzBulkBonusMultipliers.map(([min, mult]) => {
          const pct = Math.round((mult - 1) * 100);
          const label = formatFiat(min, buzzPrice, fiatSymbol);
          return (
            <button
              key={min}
              type="button"
              onClick={openBulkBonusInfo}
              className="flex flex-1 flex-col items-center gap-0.5 rounded-md border border-blue-500/20 bg-blue-500/[0.05] px-2 py-1.5 transition-colors hover:border-blue-500/40 hover:bg-blue-500/[0.1] dark:border-blue-400/20 dark:bg-blue-400/[0.04] dark:hover:border-blue-400/40 dark:hover:bg-blue-400/[0.08]"
            >
              <Text size="xs" fw={700} c="blue.4" lh={1}>
                +{pct}%
              </Text>
              <Text size="10px" c="dimmed" lh={1}>
                {label}+
              </Text>
            </button>
          );
        })}
      </Group>
    </Stack>
  );
}
