import { Paper, Stack, Text, Title, Box, Group, Skeleton, Button, Avatar } from '@mantine/core';
import { IconTrophy, IconChevronRight, IconChevronLeft } from '@tabler/icons-react';
import clsx from 'clsx';
import { abbreviateNumber } from '~/utils/number-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { PrizePosition } from '~/components/Crucible/CruciblePrizeBreakdown';
import { useState } from 'react';
import { getInitials } from '~/utils/string-helpers';

export type LeaderboardEntry = {
  id: number;
  userId: number;
  imageId: number;
  score: number;
  position: number | null;
  createdAt: Date;
  user: {
    id: number;
    username: string | null;
    image: string | null;
  };
  image: {
    id: number;
    name: string | null;
    url: string;
    nsfwLevel: number;
    width: number | null;
    height: number | null;
  };
};

export type CrucibleLeaderboardProps = {
  entries: LeaderboardEntry[];
  prizePositions: PrizePosition[];
  totalPrizePool: number;
  className?: string;
  pageSize?: number;
};

/**
 * CrucibleLeaderboard - Displays entries ranked by ELO score
 *
 * Features:
 * - Entries ranked by ELO score
 * - Entry thumbnail, score, and position
 * - Crown icons for top 3 positions (gold, silver, bronze)
 * - Highlights current user's entries
 * - Pagination for many entries
 */
export function CrucibleLeaderboard({
  entries,
  prizePositions,
  totalPrizePool,
  className,
  pageSize = 10,
}: CrucibleLeaderboardProps) {
  const currentUser = useCurrentUser();
  const [page, setPage] = useState(0);

  // Sort entries by score descending to get rankings
  const sortedEntries = [...entries].sort((a, b) => b.score - a.score);

  // Assign positions based on sort order
  const rankedEntries = sortedEntries.map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));

  // Calculate pagination
  const totalPages = Math.ceil(rankedEntries.length / pageSize);
  const paginatedEntries = rankedEntries.slice(page * pageSize, (page + 1) * pageSize);
  const showPagination = totalPages > 1;

  // Map prize positions for quick lookup
  const prizeMap = new Map<number, PrizePosition>();
  prizePositions.forEach((prize) => prizeMap.set(prize.position, prize));

  // Calculate remaining prize pool for 4th-10th place
  const top3Percentage = prizePositions
    .filter((p) => p.position <= 3)
    .reduce((sum, p) => sum + p.percentage, 0);
  const remainingPercentage = 100 - top3Percentage;
  const remainingPrizeAmount = Math.floor((remainingPercentage / 100) * totalPrizePool);
  const hasRemainingPrize = remainingPercentage > 0;

  // Get the range of remaining positions (e.g., "4th - 10th")
  const remainingPositions = prizePositions.filter((p) => p.position > 3);
  const minRemainingPos =
    remainingPositions.length > 0 ? Math.min(...remainingPositions.map((p) => p.position)) : 4;
  const maxRemainingPos =
    remainingPositions.length > 0 ? Math.max(...remainingPositions.map((p) => p.position)) : 10;
  const remainingPosLabel =
    minRemainingPos === maxRemainingPos
      ? `${minRemainingPos}${getOrdinalSuffix(minRemainingPos)} Place`
      : `${minRemainingPos}${getOrdinalSuffix(
          minRemainingPos
        )} - ${maxRemainingPos}${getOrdinalSuffix(maxRemainingPos)} Place`;

  return (
    <Paper className={clsx('rounded-lg p-6', className)} bg="dark.6">
      {/* Section header */}
      <div className="mb-4 border-b border-[#373a40] pb-4">
        <Title order={4} className="mb-4 flex items-center gap-2 text-white">
          <IconTrophy size={20} className="text-yellow-500" />
          Prize Pool & Leaderboard
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

      {/* Leaderboard entries - only show top 3 with full details */}
      <Stack gap="sm">
        {paginatedEntries.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="md">
            No entries yet
          </Text>
        ) : (
          paginatedEntries.map((entry) => (
            <LeaderboardEntryItem
              key={entry.id}
              entry={entry}
              rank={entry.rank}
              prizeInfo={prizeMap.get(entry.rank)}
              totalPrizePool={totalPrizePool}
              isCurrentUser={currentUser?.id === entry.userId}
            />
          ))
        )}
      </Stack>

      {/* Distribution box for remaining prize positions */}
      {hasRemainingPrize && (
        <Box className="mt-4 rounded-lg bg-[#25262b] p-3">
          <Text size="sm" fw={600} c="white" mb={4}>
            {remainingPosLabel}
          </Text>
          <Text size="xs" c="dimmed">
            {remainingPercentage}% ({abbreviateNumber(remainingPrizeAmount)} Buzz) - Divided equally
          </Text>
        </Box>
      )}

      {/* Pagination controls */}
      {showPagination && (
        <Group justify="center" mt="md" gap="sm">
          <Button
            variant="subtle"
            size="xs"
            leftSection={<IconChevronLeft size={14} />}
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            Prev
          </Button>
          <Text size="xs" c="dimmed">
            {page + 1} / {totalPages}
          </Text>
          <Button
            variant="subtle"
            size="xs"
            rightSection={<IconChevronRight size={14} />}
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </Group>
      )}
    </Paper>
  );
}

type LeaderboardEntryItemProps = {
  entry: LeaderboardEntry;
  rank: number;
  prizeInfo?: PrizePosition;
  totalPrizePool: number;
  isCurrentUser?: boolean;
};

/**
 * Individual leaderboard entry with medal styling for top 3
 */
function LeaderboardEntryItem({
  entry,
  rank,
  prizeInfo,
  totalPrizePool,
  isCurrentUser,
}: LeaderboardEntryItemProps) {
  const isTopThree = rank <= 3;
  const prizeAmount = prizeInfo ? Math.floor((prizeInfo.percentage / 100) * totalPrizePool) : 0;

  // Medal colors based on position
  const getMedalStyle = () => {
    switch (rank) {
      case 1:
        return {
          borderColor: '#fab005', // Gold
          bgColor: 'rgba(250, 176, 5, 0.2)',
          textColor: '#fab005',
          label: '1st',
          icon: '👑',
        };
      case 2:
        return {
          borderColor: '#868e96', // Silver
          bgColor: 'rgba(134, 142, 150, 0.2)',
          textColor: '#adb5bd',
          label: '2nd',
          icon: null,
        };
      case 3:
        return {
          borderColor: '#cd7f32', // Bronze
          bgColor: 'rgba(205, 127, 50, 0.2)',
          textColor: '#ffa94d',
          label: '3rd',
          icon: null,
        };
      default:
        return {
          borderColor: 'transparent',
          bgColor: 'rgba(201, 203, 207, 0.1)',
          textColor: '#909296',
          label: `${rank}${getOrdinalSuffix(rank)}`,
          icon: null,
        };
    }
  };

  const style = getMedalStyle();

  return (
    <Box
      className="rounded-lg p-3"
      style={{
        background: isCurrentUser ? 'rgba(34, 139, 230, 0.15)' : '#25262b',
        borderLeft: `3px solid ${style.borderColor}`,
        border: isCurrentUser ? '1px solid rgba(34, 139, 230, 0.5)' : undefined,
      }}
    >
      {/* Prize position header for top 3 */}
      {isTopThree && prizeInfo && (
        <div className="mb-3 flex items-center justify-between">
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
              {style.label}
            </Box>

            {/* Position info */}
            <div>
              <Text size="sm" fw={600} c="white">
                {style.label} Place
              </Text>
              <Text size="xs" c="dimmed">
                {prizeInfo.percentage}% ({abbreviateNumber(prizeAmount)} Buzz)
              </Text>
            </div>
          </Group>
        </div>
      )}

      {/* Entry details */}
      <div className="flex items-center gap-3">
        {/* Crown/position indicator */}
        <div
          className="flex h-6 w-6 items-center justify-center font-bold"
          style={{
            color: style.textColor,
            fontSize: style.icon ? '1.125rem' : '0.875rem',
          }}
        >
          {style.icon || rank}
        </div>

        {/* User avatar */}
        <Avatar
          src={entry.user.image}
          size={40}
          radius="xl"
          styles={{
            root: {
              flexShrink: 0,
            },
            placeholder: {
              background: 'linear-gradient(135deg, #7950f2 0%, #228be6 100%)',
              color: 'white',
              fontWeight: 600,
              fontSize: '14px',
            },
          }}
        >
          {getInitials(entry.user.username || 'A')}
        </Avatar>

        {/* User info */}
        <div className="min-w-0 flex-1">
          <Text size="sm" fw={600} c="white" truncate>
            @{entry.user.username || 'anonymous'}
          </Text>
          {isCurrentUser && (
            <Text size="xs" c="blue">
              Your entry
            </Text>
          )}
        </div>

        {/* Score */}
        <Text size="sm" fw={600} className="text-blue-400">
          {Math.round(entry.score)} pts
        </Text>
      </div>

      {/* Status text for top 3 */}
      {isTopThree && (
        <Text size="xs" c="dimmed" mt={6}>
          {rank === 1
            ? 'Currently on track to win'
            : rank === 2
            ? 'Closing in quickly'
            : 'Strong position'}
        </Text>
      )}
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

/**
 * Skeleton loader for CrucibleLeaderboard
 */
export function CrucibleLeaderboardSkeleton({ className }: { className?: string }) {
  return (
    <Paper className={clsx('rounded-lg p-6', className)} bg="dark.6">
      {/* Header skeleton */}
      <div className="mb-4 border-b border-[#373a40] pb-4">
        <Skeleton height={24} width={200} mb="md" />
        <Skeleton height={60} radius="md" />
      </div>

      {/* Entry skeletons */}
      <Stack gap="sm">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} height={80} radius="md" />
        ))}
      </Stack>
    </Paper>
  );
}
