import { Paper, Stack, Text, Title, Box, Group } from '@mantine/core';
import { IconCrown, IconTrophy } from '@tabler/icons-react';
import clsx from 'clsx';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '~/shared/utils/prisma/enums';
import { abbreviateNumber } from '~/utils/number-helpers';

export type PrizePosition = {
  position: number;
  percentage: number;
};

export type CruciblePrizeBreakdownProps = {
  prizePositions: PrizePosition[];
  totalPrizePool: number;
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
  className,
}: CruciblePrizeBreakdownProps) {
  // Sort positions by position number to ensure correct order
  const sortedPositions = [...prizePositions].sort((a, b) => a.position - b.position);

  return (
    <Paper className={clsx('rounded-lg p-6', className)} bg="dark.6">
      {/* Section header */}
      <div className="mb-4 border-b border-[#373a40] pb-4">
        <Title order={4} className="mb-4 flex items-center gap-2 text-white">
          <IconTrophy size={20} className="text-yellow-500" />
          Prize Pool
        </Title>

        {/* Total prize pool box */}
        <Box className="rounded-lg bg-[#1a1b1e] p-3 text-center">
          <Text className="text-2xl font-bold text-yellow-500">
            {abbreviateNumber(totalPrizePool)} Buzz
          </Text>
          <Text size="xs" c="dimmed" mt={4}>
            Total Prize Pool
          </Text>
        </Box>
      </div>

      {/* Prize positions */}
      <Stack gap="sm">
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
          borderColor: '#fab005', // Gold
          bgColor: 'rgba(250, 176, 5, 0.2)',
          textColor: '#fab005',
          label: '1st',
        };
      case 2:
        return {
          borderColor: '#868e96', // Silver
          bgColor: 'rgba(134, 142, 150, 0.2)',
          textColor: '#adb5bd',
          label: '2nd',
        };
      case 3:
        return {
          borderColor: '#cd7f32', // Bronze
          bgColor: 'rgba(205, 127, 50, 0.2)',
          textColor: '#ffa94d',
          label: '3rd',
        };
      default:
        return {
          borderColor: 'transparent',
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
        borderLeft: `3px solid ${style.borderColor}`,
      }}
    >
      <Group justify="space-between" align="center">
        {/* Position badge and prize info */}
        <Group gap="sm">
          {/* Medal badge */}
          <Box
            className="flex h-7 w-7 items-center justify-center rounded-md font-bold"
            style={{
              background: style.bgColor,
              color: style.textColor,
              fontSize: '0.875rem',
            }}
          >
            {isTopThree ? <IconCrown size={16} /> : style.label}
          </Box>

          {/* Position info */}
          <div>
            <Text size="sm" fw={600} c="white">
              {style.label} Place
            </Text>
            <Text size="xs" c="dimmed">
              {percentage}% ({abbreviateNumber(prizeAmount)} Buzz)
            </Text>
          </div>
        </Group>

        {/* Currency badge */}
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

// Export a helper to parse JSON prize positions from the database
export function parsePrizePositions(
  prizePositionsJson: unknown
): PrizePosition[] {
  if (!prizePositionsJson || !Array.isArray(prizePositionsJson)) {
    return [];
  }

  return prizePositionsJson
    .filter(
      (item): item is { position: number; percentage: number } =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.position === 'number' &&
        typeof item.percentage === 'number'
    )
    .map((item) => ({
      position: item.position,
      percentage: item.percentage,
    }));
}
