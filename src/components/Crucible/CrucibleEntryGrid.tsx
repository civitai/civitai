import {
  Box,
  Button,
  Center,
  Loader,
  Paper,
  SimpleGrid,
  Skeleton,
  Text,
  Title,
} from '@mantine/core';
import { IconChartLine, IconCrown, IconPhoto, IconPlus, IconUsers } from '@tabler/icons-react';
import clsx from 'clsx';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { CrucibleUserLink } from '~/components/Crucible/CrucibleUserLink';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { MediaType } from '~/shared/utils/prisma/enums';

export type CrucibleEntryData = {
  id: number;
  userId: number;
  imageId: number;
  score: number | null;
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
    type: MediaType;
    metadata?: MixedObject | null;
    nsfwLevel: number;
    width: number | null;
    height: number | null;
  };
};

export type CrucibleEntryGridProps = {
  entries: CrucibleEntryData[];
  /** The viewer's own entries, which may not be on any page loaded so far. */
  viewerEntries?: CrucibleEntryData[];
  /** Every entry in the crucible, loaded or not. */
  totalCount?: number;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  title?: string;
  showRanks?: boolean;
  showUserEntries?: boolean;
  currentUserId?: number | null;
  maxUserEntries?: number;
  className?: string;
  emptyMessage?: string;
  onEntryClick?: (entry: CrucibleEntryData) => void;
};

const scoreOf = (entry: CrucibleEntryData) => entry.score ?? Number.NEGATIVE_INFINITY;

/**
 * CrucibleEntryGrid - Displays crucible entries in a masonry-style grid
 *
 * Features:
 * - Entry thumbnails in a grid layout
 * - Score/position overlay when ranks are visible
 * - Click to view full image
 * - Empty state handling
 * - Optional "Your Entries" section for current user's entries
 */
export function CrucibleEntryGrid({
  entries,
  viewerEntries = [],
  totalCount,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  title,
  showRanks = false,
  showUserEntries = false,
  currentUserId,
  maxUserEntries,
  className,
  emptyMessage = 'No entries yet',
  onEntryClick,
}: CrucibleEntryGridProps) {
  const currentUser = useCurrentUser();
  const userId = currentUserId ?? currentUser?.id;

  // Pages arrive in score order once ranks are visible, so a loaded entry's index is its rank;
  // the viewer's own entries may sit on a page not loaded yet and carry their final position.
  const rankedEntries = showRanks
    ? [...entries]
        .sort((a, b) => scoreOf(b) - scoreOf(a))
        .map((entry, index) => ({ ...entry, rank: entry.position ?? index + 1 }))
    : entries.map((entry) => ({ ...entry, rank: null }));

  const separateViewer = showUserEntries && !!userId;
  const userEntries = separateViewer
    ? viewerEntries.map((entry) => ({ ...entry, rank: showRanks ? entry.position : null }))
    : [];

  const displayEntries = separateViewer
    ? rankedEntries.filter((e) => e.userId !== userId)
    : rankedEntries;
  const displayCount =
    totalCount !== undefined
      ? totalCount - (separateViewer ? userEntries.length : 0)
      : displayEntries.length;

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
              ({displayCount})
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
        ) : hasMore || isLoadingMore ? null : userEntries.length > 0 ? (
          <CrucibleEntryGridEmpty message="No one else has entered yet" subtext={null} />
        ) : (
          <CrucibleEntryGridEmpty message={emptyMessage} />
        )}

        {hasMore && onLoadMore && (
          <InViewLoader loadFn={onLoadMore} loadCondition={!isLoadingMore}>
            <Center py="md">
              <Loader size="sm" />
            </Center>
          </InViewLoader>
        )}
      </div>
    </div>
  );
}

type EntryCardProps = {
  entry: CrucibleEntryData;
  rank: number | null;
  isUserEntry?: boolean;
  onClick?: () => void;
};

/**
 * Individual entry card with image, overlay, and position badge
 */
function EntryCard({ entry, rank, isUserEntry, onClick }: EntryCardProps) {
  return (
    <Box
      className="group cursor-pointer overflow-hidden rounded-lg bg-[#25262b] transition-colors hover:bg-[#2c2e33]"
      onClick={onClick}
    >
      {/* Image container with 4:5 aspect ratio */}
      <div className="relative" style={{ aspectRatio: '4 / 5' }}>
        <div className="absolute inset-0 bg-[#373a40]">
          <EdgeMedia2
            src={entry.image.url}
            name={entry.image.name}
            type={entry.image.type}
            metadata={entry.image.metadata}
            skip={getSkipValue({ type: entry.image.type, metadata: entry.image.metadata })}
            className="transition-transform duration-300 group-hover:scale-105"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            wrapperProps={{ className: 'size-full' }}
            width={320}
          />
        </div>

        {/* Position badge */}

        {/* Gradient overlay */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent from-50% to-black/80" />

        {/* Entry info overlay */}
        <div className="absolute inset-x-0 bottom-0 flex flex-col p-3 text-white">
          {/* Author */}
          <Text size="xs" c="gray.4">
            by{' '}
            <CrucibleUserLink user={entry.user}>
              @{entry.user.username || 'anonymous'}
            </CrucibleUserLink>
          </Text>

          {/* Stats */}
          {rank !== null && entry.score !== null && (
            <div className="mt-2 flex gap-3 border-t border-white/10 pt-2 text-xs text-gray-400">
              <div className="flex items-center gap-1">
                <IconChartLine size={12} />
                <span>{Math.round(entry.score)} pts</span>
              </div>
              <div
                className="flex items-center gap-1"
                style={rank <= 3 ? { color: medalColors[rank - 1], fontWeight: 600 } : undefined}
              >
                {rank <= 3 && <IconCrown size={12} />}#{rank}
              </div>
            </div>
          )}
        </div>
      </div>
    </Box>
  );
}

// Gold, silver, bronze.
const medalColors = ['#ffe066', '#adb5bd', '#ffa94d'];

type CrucibleEntryGridEmptyProps = {
  message?: string;
  /** `null` renders no subtext; `undefined` gets the default. */
  subtext?: string | null;
  showSubmitButton?: boolean;
  onSubmitClick?: () => void;
};

/**
 * Empty state for the entry grid
 */
export function CrucibleEntryGridEmpty({
  message = 'No entries yet',
  subtext = 'Be the first to submit an entry!',
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
      {subtext && (
        <Text size="sm" c="dimmed" mb={showSubmitButton ? 'md' : undefined}>
          {subtext}
        </Text>
      )}
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
