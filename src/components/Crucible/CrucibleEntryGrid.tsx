import { Box, Button, Paper, Text, Title, SimpleGrid, Skeleton, Badge } from '@mantine/core';
import { IconPhoto, IconTrophy, IconChartLine, IconUsers, IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { abbreviateNumber } from '~/utils/number-helpers';
import Link from 'next/link';

export type CrucibleEntryData = {
  id: number;
  userId: number;
  imageId: number;
  score: number;
  position: number | null;
  createdAt: Date;
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
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

export type CrucibleEntryGridProps = {
  entries: CrucibleEntryData[];
  title?: string;
  showUserEntries?: boolean;
  currentUserId?: number | null;
  maxUserEntries?: number;
  className?: string;
  emptyMessage?: string;
  onEntryClick?: (entry: CrucibleEntryData) => void;
};

/**
 * CrucibleEntryGrid - Displays crucible entries in a masonry-style grid
 *
 * Features:
 * - Entry thumbnails in a grid layout
 * - Score/position overlay on hover
 * - Click to view full image
 * - Empty state handling
 * - Optional "Your Entries" section for current user's entries
 */
export function CrucibleEntryGrid({
  entries,
  title,
  showUserEntries = false,
  currentUserId,
  maxUserEntries,
  className,
  emptyMessage = 'No entries yet',
  onEntryClick,
}: CrucibleEntryGridProps) {
  const currentUser = useCurrentUser();
  const userId = currentUserId ?? currentUser?.id;

  // Sort entries by score to calculate ranks
  const sortedEntries = [...entries].sort((a, b) => b.score - a.score);
  const rankedEntries = sortedEntries.map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));

  // Filter user's entries if requested
  const userEntries =
    showUserEntries && userId ? rankedEntries.filter((e) => e.userId === userId) : [];

  // All entries (or non-user entries if showing user entries separately)
  const displayEntries =
    showUserEntries && userId ? rankedEntries.filter((e) => e.userId !== userId) : rankedEntries;

  return (
    <div className={clsx(className)}>
      {/* User Entries Section */}
      {showUserEntries && userId && userEntries.length > 0 && (
        <div className="mb-8">
          <Title order={4} className="mb-4 flex items-center gap-2 text-white">
            <IconPhoto size={20} className="text-blue-500" />
            Your Entries
            <Text component="span" size="sm" c="dimmed" fw="normal">
              ({userEntries.length}
              {maxUserEntries ? ` of ${maxUserEntries}` : ''})
            </Text>
          </Title>
          <SimpleGrid
            cols={{ base: 2, xs: 3, sm: 4, md: 5, lg: 6 }}
            spacing={{ base: 'sm', md: 'md' }}
          >
            {userEntries.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                rank={entry.rank}
                isUserEntry
                onClick={() => onEntryClick?.(entry)}
              />
            ))}
          </SimpleGrid>
        </div>
      )}

      {/* All Entries Section */}
      <div>
        {title && (
          <Title order={4} className="mb-4 flex items-center gap-2 text-white">
            <IconUsers size={20} className="text-gray-500" />
            {title}
            <Text component="span" size="sm" c="dimmed" fw="normal">
              ({entries.length})
            </Text>
          </Title>
        )}

        {displayEntries.length > 0 ? (
          <SimpleGrid
            cols={{ base: 2, xs: 3, sm: 4, md: 5, lg: 6 }}
            spacing={{ base: 'sm', md: 'md' }}
          >
            {displayEntries.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                rank={entry.rank}
                onClick={() => onEntryClick?.(entry)}
              />
            ))}
          </SimpleGrid>
        ) : (
          <CrucibleEntryGridEmpty message={emptyMessage} />
        )}
      </div>
    </div>
  );
}

type EntryCardProps = {
  entry: CrucibleEntryData & { rank: number };
  rank: number;
  isUserEntry?: boolean;
  onClick?: () => void;
};

/**
 * Individual entry card with image, overlay, and position badge
 */
function EntryCard({ entry, rank, isUserEntry, onClick }: EntryCardProps) {
  const isTopThree = rank <= 3;

  return (
    <Box
      className="group cursor-pointer overflow-hidden rounded-lg bg-[#25262b] transition-colors hover:bg-[#2c2e33]"
      onClick={onClick}
    >
      {/* Image container with 4:5 aspect ratio */}
      <div className="relative" style={{ aspectRatio: '4 / 5' }}>
        <div className="absolute inset-0 bg-[#373a40]">
          <EdgeMedia
            src={entry.image.url}
            name={entry.image.name}
            type="image"
            className="size-full object-cover transition-transform duration-300 group-hover:scale-105"
            width={320}
          />
        </div>

        {/* Position badge */}
        <PositionBadge rank={rank} isTopThree={isTopThree} />

        {/* Gradient overlay */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent from-50% to-black/80" />

        {/* Entry info overlay */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col p-3 text-white">
          {/* Entry name (fallback to image name or "Entry") */}
          <Text size="sm" fw={600} lineClamp={1} lh={1.25}>
            {entry.image.name || 'Entry'}
          </Text>

          {/* Author */}
          <Text size="xs" c="gray.4" mt={2}>
            by @{entry.user.username || 'anonymous'}
          </Text>

          {/* Stats */}
          <div className="mt-2 flex gap-3 border-t border-white/10 pt-2 text-xs text-gray-400">
            <div className="flex items-center gap-1">
              <IconChartLine size={12} />
              <span>{Math.round(entry.score)} pts</span>
            </div>
            <div className="flex items-center gap-1">#{rank}</div>
          </div>
        </div>
      </div>
    </Box>
  );
}

type PositionBadgeProps = {
  rank: number;
  isTopThree: boolean;
};

/**
 * Position badge displayed in top-right corner of entry card
 */
function PositionBadge({ rank, isTopThree }: PositionBadgeProps) {
  if (isTopThree) {
    return (
      <Badge
        className="absolute right-2 top-2 z-10 flex items-center gap-1"
        style={{
          background: 'linear-gradient(135deg, #fab005 0%, #fd7e14 100%)',
        }}
        radius="sm"
        px={8}
        size="sm"
      >
        <IconTrophy size={12} />#{rank}
      </Badge>
    );
  }

  return (
    <Badge
      className="absolute right-2 top-2 z-10 flex items-center gap-1"
      style={{ background: 'rgba(0, 0, 0, 0.7)' }}
      radius="sm"
      px={8}
      size="sm"
    >
      <IconChartLine size={12} />#{rank}
    </Badge>
  );
}

type CrucibleEntryGridEmptyProps = {
  message?: string;
  showSubmitButton?: boolean;
  onSubmitClick?: () => void;
};

/**
 * Empty state for the entry grid
 */
export function CrucibleEntryGridEmpty({
  message = 'No entries yet',
  showSubmitButton = false,
  onSubmitClick,
}: CrucibleEntryGridEmptyProps) {
  return (
    <Paper
      className="flex flex-col items-center justify-center rounded-lg py-16 text-center"
      bg="dark.6"
    >
      <IconPhoto size={48} className="mb-4 text-gray-500" />
      <Text size="lg" fw={600} c="white" mb={4}>
        {message}
      </Text>
      <Text size="sm" c="dimmed" mb={showSubmitButton ? 'md' : undefined}>
        Be the first to submit an entry!
      </Text>
      {showSubmitButton && onSubmitClick && (
        <Button
          size="md"
          leftSection={<IconPlus size={18} />}
          onClick={onSubmitClick}
          className="bg-blue-600 hover:bg-blue-500"
        >
          Submit Entry
        </Button>
      )}
    </Paper>
  );
}

/**
 * Skeleton loader for CrucibleEntryGrid
 */
export function CrucibleEntryGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <SimpleGrid cols={{ base: 2, xs: 3, sm: 4, md: 5, lg: 6 }} spacing={{ base: 'sm', md: 'md' }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} radius="md" style={{ aspectRatio: '4 / 5' }} />
      ))}
    </SimpleGrid>
  );
}
