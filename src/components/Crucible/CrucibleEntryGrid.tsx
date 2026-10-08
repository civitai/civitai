import {
  ActionIcon,
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
import { IconCrown, IconPhoto, IconPlus, IconTrash, IconUsers } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState, type MouseEvent } from 'react';
import { EdgeMedia2 } from '~/components/EdgeMedia/EdgeMedia';
import { getSkipValue } from '~/components/EdgeMedia/EdgeMedia.util';
import { ImageGuard2 } from '~/components/ImageGuard/ImageGuard2';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import {
  CrucibleEntryMediaViewer,
  type CrucibleEntryMedia,
} from '~/components/Crucible/CrucibleEntryMediaViewer';
import { CrucibleUserLink } from '~/components/Crucible/CrucibleUserLink';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ProfileImage } from '~/server/selectors/image.selector';
import type { CrucibleStatus, MediaType } from '~/shared/utils/prisma/enums';
import { canSeeCrucibleEntryDetails, rankCrucibleEntries } from '~/utils/crucible-helpers';
import { numberWithCommas } from '~/utils/number-helpers';

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
    profilePicture?: ProfileImage | null;
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
    hash?: string | null;
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
  /** Ranks come from placings; entries without enough votes to place get none. */
  completed?: boolean;
  showUserEntries?: boolean;
  currentUserId?: number | null;
  maxUserEntries?: number;
  className?: string;
  emptyMessage?: string;
  /** `openableImageIds` is every entry the viewer may open, in grid order, for paging. */
  onEntryClick?: (entry: CrucibleEntryData, openableImageIds: number[]) => void;
  /**
   * Until the crucible ends, other people's entries show no creator and open in a media-only
   * viewer instead of the image detail.
   */
  status: CrucibleStatus;
  /** Moderators only, while the crucible runs. */
  onRemoveEntry?: (entry: CrucibleEntryData) => void;
  /** The viewer taking back one of their own entries, while the crucible runs. */
  onWithdrawEntry?: (entry: CrucibleEntryData) => void;
};

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
  completed = false,
  showUserEntries = false,
  currentUserId,
  maxUserEntries,
  className,
  emptyMessage = 'No entries yet',
  onEntryClick,
  onRemoveEntry,
  onWithdrawEntry,
  status,
}: CrucibleEntryGridProps) {
  const currentUser = useCurrentUser();
  const userId = currentUserId ?? currentUser?.id;
  const canSeeDetails = (entry: CrucibleEntryData) =>
    canSeeCrucibleEntryDetails({
      status,
      isModerator: currentUser?.isModerator ?? false,
      isOwnEntry: entry.userId === userId,
    });

  const rankedEntries = showRanks
    ? rankCrucibleEntries(entries, { completed })
    : entries.map((entry) => ({ ...entry, rank: null }));

  const separateViewer = showUserEntries && !!userId;
  const userEntries = separateViewer
    ? viewerEntries.map((entry) => ({ ...entry, rank: showRanks ? entry.position : null }))
    : [];

  const displayEntries = separateViewer
    ? rankedEntries.filter((e) => e.userId !== userId)
    : rankedEntries;
  const gridOrder = [...userEntries, ...displayEntries];
  const openableImageIds = gridOrder.filter(canSeeDetails).map((entry) => entry.imageId);
  const hiddenEntries = gridOrder.filter((entry) => !canSeeDetails(entry));
  const hiddenMedia: CrucibleEntryMedia[] = hiddenEntries.map(({ id, image }) => ({
    entryId: id,
    url: image.url,
    name: image.name,
    type: image.type,
    metadata: image.metadata,
  }));
  // Keyed by entry, not position, so a list that changes under the viewer can't swap what it shows.
  const [viewerEntryId, setViewerEntryId] = useState<number | null>(null);
  const viewerIndex = hiddenMedia.findIndex(({ entryId }) => entryId === viewerEntryId);
  const openEntry = (entry: CrucibleEntryData) => {
    if (canSeeDetails(entry)) onEntryClick?.(entry, openableImageIds);
    else setViewerEntryId(entry.id);
  };
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
                showDetails={canSeeDetails(entry)}
                onClick={() => openEntry(entry)}
                onRemove={onWithdrawEntry && (() => onWithdrawEntry(entry))}
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
              ({numberWithCommas(displayCount)})
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
                showDetails={canSeeDetails(entry)}
                onClick={() => openEntry(entry)}
                onRemove={onRemoveEntry && (() => onRemoveEntry(entry))}
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

      <CrucibleEntryMediaViewer
        media={hiddenMedia}
        index={viewerIndex === -1 ? null : viewerIndex}
        hasMore={hasMore}
        onIndexChange={(index) => setViewerEntryId(hiddenMedia[index]?.entryId ?? null)}
        onClose={() => setViewerEntryId(null)}
      />
    </div>
  );
}

type EntryCardProps = {
  entry: CrucibleEntryData;
  rank: number | null;
  isUserEntry?: boolean;
  showDetails: boolean;
  onClick?: () => void;
  onRemove?: () => void;
};

/**
 * Individual entry card with image, overlay, and position badge
 */
function EntryCard({ entry, rank, isUserEntry, showDetails, onClick, onRemove }: EntryCardProps) {
  return (
    <Box
      className="group cursor-pointer overflow-hidden rounded-lg bg-[#25262b] transition-colors hover:bg-[#2c2e33]"
      onClick={onClick}
    >
      {/* Image container with 4:5 aspect ratio */}
      <div className="relative" style={{ aspectRatio: '4 / 5' }}>
        <div className="absolute inset-0 bg-[#373a40]">
          <ImageGuard2 image={{ ...entry.image, userId: entry.userId }}>
            {(safe) =>
              safe ? (
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
              ) : (
                <MediaHash {...entry.image} />
              )
            }
          </ImageGuard2>
        </div>

        {rank !== null && (
          <div
            className="absolute right-2 top-2 flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold tabular-nums"
            style={
              rank <= 3
                ? { background: medalColors[rank - 1], color: '#1a1b1e' }
                : { background: 'rgba(0, 0, 0, 0.55)', color: 'white' }
            }
          >
            {rank <= 3 && <IconCrown size={12} />}#{rank}
          </div>
        )}

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent from-50% to-black/80" />

        {onRemove && (
          <ActionIcon
            variant="filled"
            color="red"
            size="sm"
            radius="xl"
            className="absolute left-2 top-2"
            aria-label="Remove entry"
            title="Remove entry"
            onClick={(event: MouseEvent) => {
              event.stopPropagation();
              onRemove();
            }}
          >
            <IconTrash size={14} />
          </ActionIcon>
        )}

        <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3 text-white">
          {showDetails && (
            <CrucibleUserLink user={entry.user}>
              <span className="flex min-w-0 items-center gap-1.5">
                <UserAvatar user={entry.user} size="xs" />
                <Text size="xs" fw={600} c="white" truncate>
                  {entry.user.deletedAt ? '[deleted]' : entry.user.username || 'anonymous'}
                </Text>
              </span>
            </CrucibleUserLink>
          )}
          {rank !== null && entry.score !== null && (
            <Text size="xs" c="gray.4" className="tabular-nums">
              {Math.round(entry.score).toLocaleString()} pts
            </Text>
          )}
        </div>
      </div>
    </Box>
  );
}

// Gold, silver, bronze.
const medalColors = ['#fab005', '#adb5bd', '#e8590c'];

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
