import { Badge, Paper, Stack, Text, ThemeIcon, Box, Group } from '@mantine/core';
import { IconCrown, IconTrendingUp } from '@tabler/icons-react';
import clsx from 'clsx';
import { getBackground, getBorder } from '~/components/Challenge/DynamicPrizeCard/constants';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Currency } from '~/shared/utils/prisma/enums';
import type { PrizePosition } from '~/utils/crucible-helpers';
import classes from './CruciblePrizeBreakdown.module.scss';

export type CruciblePrizeBreakdownProps = {
  prizePositions: PrizePosition[];
  totalPrizePool: number;
  entryFee: number;
  className?: string;
};

/**
 * CruciblePrizeBreakdown - Visual display of prize distribution
 *
 * Displays:
 * - Total prize pool at the top
 * - Individual prize positions with crown icons for top 3
 * - Percentage and calculated Buzz amounts for each position
 * - Handles variable number of prize positions
 */
export function CruciblePrizeBreakdown({
  prizePositions,
  totalPrizePool,
  entryFee,
  className,
}: CruciblePrizeBreakdownProps) {
  // Sort positions by position number to ensure correct order
  const sortedPositions = [...prizePositions].sort((a, b) => a.position - b.position);

  return (
    <Paper className={clsx('overflow-hidden rounded-lg', className)} bg="dark.6">
      <Stack
        gap="sm"
        align="center"
        p="md"
        style={{
          borderBottom: getBorder('dark', 'teal'),
          background: getBackground('dark', 'teal'),
        }}
      >
        <Group gap={6} justify="center">
          <ThemeIcon variant="light" color="teal" size="sm" radius="xl">
            <IconTrendingUp size={14} />
          </ThemeIcon>
          <Text size="sm" fw={700} tt="uppercase" lts={0.5} c="white">
            Growing Prize Pool
          </Text>
        </Group>
        <Group gap={6} justify="center" align="baseline">
          <CurrencyIcon currency={Currency.BUZZ} size={28} />
          <Text fw={900} className={classes.amount}>
            {totalPrizePool.toLocaleString()}
          </Text>
        </Group>
        {entryFee > 0 && (
          <Badge
            size="lg"
            variant="light"
            color="teal"
            leftSection={<IconTrendingUp size={14} />}
            className={classes.pulse}
          >
            +{entryFee.toLocaleString()} Buzz per entry
          </Badge>
        )}
      </Stack>

      <Stack gap="sm" p="md">
        {sortedPositions.map((prize) => (
          <PrizePositionItem
            key={prize.position}
            position={prize.position}
            percentage={prize.percentage}
            totalPrizePool={totalPrizePool}
          />
        ))}
      </Stack>
    </Paper>
  );
}

type PrizePositionItemProps = {
  position: number;
  percentage: number;
  totalPrizePool: number;
};

/**
 * Individual prize position item with medal styling
 */
function PrizePositionItem({ position, percentage, totalPrizePool }: PrizePositionItemProps) {
  const prizeAmount = Math.floor((percentage / 100) * totalPrizePool);
  const isTopThree = position <= 3;

  // Medal colors based on position
  const getMedalStyle = () => {
    switch (position) {
      case 1:
        return {
          bgColor: 'rgba(250, 176, 5, 0.2)',
          textColor: '#fab005',
          label: '1st',
        };
      case 2:
        return {
          bgColor: 'rgba(134, 142, 150, 0.2)',
          textColor: '#adb5bd',
          label: '2nd',
        };
      case 3:
        return {
          bgColor: 'rgba(205, 127, 50, 0.2)',
          textColor: '#ffa94d',
          label: '3rd',
        };
      default:
        return {
          bgColor: 'rgba(201, 203, 207, 0.1)',
          textColor: '#909296',
          label: `${position}${getOrdinalSuffix(position)}`,
        };
    }
  };

  const style = getMedalStyle();

  return (
    <Box
      className="rounded-lg p-3"
      style={{
        background: '#25262b',
      }}
    >
      <Group justify="space-between" align="center" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          {/* Medal badge */}
          <Box
            className="flex size-7 items-center justify-center rounded-md font-bold"
            style={{
              background: style.bgColor,
              color: style.textColor,
              fontSize: '0.875rem',
            }}
          >
            {isTopThree ? <IconCrown size={16} /> : style.label}
          </Box>

          <Text size="sm" fw={600} c="white">
            {style.label} Place
          </Text>
          <Text size="xs" c="dimmed">
            {percentage}%
          </Text>
        </Group>

        <CurrencyBadge currency={Currency.BUZZ} unitAmount={prizeAmount} size="sm" />
      </Group>
    </Box>
  );
}

/**
 * Get ordinal suffix for numbers (1st, 2nd, 3rd, 4th, etc.)
 */
function getOrdinalSuffix(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
