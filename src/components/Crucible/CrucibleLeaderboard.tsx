import { Paper, Stack, Text, Title, Box, Group, Skeleton, Button } from '@mantine/core';
import { IconChevronLeft, IconChevronRight, IconCrown, IconTrophy } from '@tabler/icons-react';
import clsx from 'clsx';
import { numberWithCommas } from '~/utils/number-helpers';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { Currency } from '~/shared/utils/prisma/enums';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  rankCrucibleEntries,
  type CrucibleDisplayPrize,
  type PrizePosition,
} from '~/utils/crucible-helpers';
import { useState } from 'react';
import { CrucibleUserLink } from '~/components/Crucible/CrucibleUserLink';
import type { SimpleUser } from '~/server/selectors/user.selector';

export type LeaderboardEntry = {
  id: number;
  userId: number;
  score: number;
  position: number | null;
  user: SimpleUser;
};

export type CrucibleLeaderboardProps = {
  entries: LeaderboardEntry[];
  prizePositions: PrizePosition[];
  totalPrizePool: number;
  buzzType: 'green' | 'yellow';
  /**
   * Whether prizes were actually paid. False on a Cancelled crucible, which also reveals its
   * rankings — scores are final there, but every entry fee went back and nobody won anything.
   */
  awarded: boolean;
  className?: string;
  pageSize?: number;
  /** Every ranked entry, loaded or not; defaults to the loaded count. */
  totalCount?: number;
  /** Empty unless awarded. */
  prizeWinners: CrucibleDisplayPrize[];
  hasMore?: boolean;
  onLoadMore?: () => void;
};

/**
 * CrucibleLeaderboard - Displays entries ranked by placing
 *
 * Features:
 * - Entries ranked by placing, then unplaced entries by ELO score
 * - Score and position
 * - Crown icons for top 3 positions (gold, silver, bronze)
 * - Highlights current user's entries
 * - Pagination for many entries
 */
export function CrucibleLeaderboard({
  entries,
  prizePositions: awardedPrizePositions,
  totalPrizePool,
  buzzType,
  awarded,
  className,
  pageSize = 10,
  totalCount,
  prizeWinners: awardedPrizeWinners,
  hasMore = false,
  onLoadMore,
}: CrucibleLeaderboardProps) {
  // A cancelled crucible paid nobody, so it has no prize rows, no placings and no pool to show —
  // only the scores the entries finished on.
  const prizePositions = awarded ? awardedPrizePositions : [];
  const prizeWinners = awarded ? awardedPrizeWinners : [];
  const currentUser = useCurrentUser();
  const [page, setPage] = useState(0);

  const rankedEntries = rankCrucibleEntries(entries, { completed: awarded });

  // Calculate pagination
  const totalPages = Math.ceil((totalCount ?? rankedEntries.length) / pageSize);
  const paginatedEntries = rankedEntries.slice(page * pageSize, (page + 1) * pageSize);
  const isLoadingPage = paginatedEntries.length === 0 && hasMore;

  const goToNextPage = () => {
    if ((page + 2) * pageSize > rankedEntries.length && hasMore) onLoadMore?.();
    setPage((p) => p + 1);
  };
  const showPagination = totalPages > 1;

  // Map prize positions for quick lookup
  const prizeMap = new Map<number, PrizePosition>();
  prizePositions.forEach((prize) => prizeMap.set(prize.position, prize));

  const prizeByEntryId = new Map(prizeWinners.map((winner) => [winner.entryId, winner]));

  const remainingPositions = prizePositions.filter((p) => p.position > 3);
  const remainingPrizeAmount = prizeWinners
    .filter((winner) => winner.prizePlace > 3)
    .reduce((sum, winner) => sum + winner.prizeAmount, 0);
  const hasRemainingPrize = remainingPrizeAmount > 0;
  const minRemainingPos =
    remainingPositions.length > 0 ? Math.min(...remainingPositions.map((p) => p.position)) : 4;
  const maxRemainingPos =
    remainingPositions.length > 0 ? Math.max(...remainingPositions.map((p) => p.position)) : 10;
  const remainingIsRange = minRemainingPos !== maxRemainingPos;
  const remainingPosLabel = remainingIsRange
    ? `${minRemainingPos}${getOrdinalSuffix(
        minRemainingPos
      )} - ${maxRemainingPos}${getOrdinalSuffix(maxRemainingPos)} Prize`
    : `${minRemainingPos}${getOrdinalSuffix(minRemainingPos)} Prize`;

  return (
    <Paper className={clsx('rounded-lg p-6', className)} bg="dark.6">
      {/* Section header */}
      <div className="mb-4 border-b border-[#373a40] pb-4">
        <Title order={4} className="mb-4 flex items-center gap-2 text-white">
          <IconTrophy size={20} className="text-yellow-500" />
          {awarded ? 'Prize Pool & Leaderboard' : 'Final Standings'}
        </Title>

        {awarded ? (
          <Box className="rounded-lg bg-[#1a1b1e] p-3 text-center">
            <Text className="text-2xl font-bold text-yellow-500">
              {numberWithCommas(totalPrizePool)} Buzz
            </Text>
            <Text size="xs" c="dimmed" mt={4}>
              Total Prize Pool
            </Text>
          </Box>
        ) : (
          <Text size="sm" c="dimmed">
            This crucible was cancelled. Every entry fee was refunded and no prizes were awarded.
          </Text>
        )}
      </div>

      {/* Leaderboard entries - only show top 3 with full details */}
      <Stack gap="sm">
        {isLoadingPage ? (
          <Skeleton height={56} radius="md" />
        ) : paginatedEntries.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="md">
            No entries yet
          </Text>
        ) : (
          paginatedEntries.map((entry) => {
            const prize = prizeByEntryId.get(entry.id);
            return (
              <LeaderboardEntryItem
                key={entry.id}
                entry={entry}
                rank={entry.rank}
                prizePlace={prize?.prizePlace ?? null}
                prizeInfo={prize ? prizeMap.get(prize.prizePlace) : undefined}
                prizeAmount={prize?.prizeAmount ?? 0}
                buzzType={buzzType}
                isCurrentUser={currentUser?.id === entry.userId}
              />
            );
          })
        )}
      </Stack>

      {/* Distribution box for remaining prize positions */}
      {hasRemainingPrize && (
        <Box className="mt-4 rounded-lg bg-[#25262b] p-3">
          <Text size="sm" fw={600} c="white" mb={4}>
            {remainingPosLabel}
          </Text>
          <Text size="xs" c="dimmed">
            {numberWithCommas(remainingPrizeAmount)} Buzz
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
            onClick={goToNextPage}
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
  /** Null for an entry that didn't get enough votes to place. */
  rank: number | null;
  /** Can sit below `rank`: a creator takes one prize, so the next creator moves up. */
  prizePlace: number | null;
  prizeInfo?: PrizePosition;
  prizeAmount: number;
  buzzType: 'green' | 'yellow';
  isCurrentUser?: boolean;
};

/**
 * Individual leaderboard entry with medal styling for top 3
 */
function LeaderboardEntryItem({
  entry,
  rank,
  prizePlace,
  prizeInfo,
  prizeAmount,
  buzzType,
  isCurrentUser,
}: LeaderboardEntryItemProps) {
  const isTopThreePrize = prizePlace !== null && prizePlace <= 3;

  const getMedalStyle = () => {
    switch (prizePlace) {
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
          label: prizePlace === null ? '' : `${prizePlace}${getOrdinalSuffix(prizePlace)}`,
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
      {isTopThreePrize && prizeInfo && (
        <div className="mb-3 flex items-center justify-between gap-2">
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
              <IconCrown size={16} />
            </Box>

            <Text size="sm" fw={600} c="white">
              {style.label} Prize
            </Text>
            <Text size="xs" c="dimmed">
              {prizeInfo.percentage}%
            </Text>
          </Group>
          <CurrencyBadge
            currency={Currency.BUZZ}
            type={buzzType}
            unitAmount={prizeAmount}
            size="sm"
          />
        </div>
      )}

      {/* Entry details */}
      <div className="flex items-center gap-3">
        {/* Crown/position indicator */}
        <div
          className="flex size-6 items-center justify-center font-bold"
          style={{
            color: style.textColor,
            fontSize: '0.875rem',
          }}
        >
          {rank ?? '–'}
        </div>

        <CrucibleUserLink user={entry.user} className="flex-1">
          <UserAvatar user={entry.user} avatarSize={40} size="lg" withHoverCard={false} />

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
            {rank === null && (
              <Text size="xs" c="dimmed">
                Not enough votes to place
              </Text>
            )}
          </div>
        </CrucibleUserLink>

        {/* Score */}
        <Text size="sm" fw={600} className="text-blue-400">
          {numberWithCommas(Math.round(entry.score))} pts
        </Text>
      </div>
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
