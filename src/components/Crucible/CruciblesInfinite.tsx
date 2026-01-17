import type { GetCruciblesInfiniteSchema } from '~/server/schema/crucible.schema';
import { Button, Center, Loader, LoadingOverlay, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconTrophy, IconPlus, IconSearch } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import Link from 'next/link';
import { useEffect } from 'react';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { removeEmpty } from '~/utils/object-helpers';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { CrucibleCard, CrucibleCardSkeleton } from '~/components/Cards/CrucibleCard';
import { useCrucibleFilters, useQueryCrucibles } from './crucible.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useMasonryContext } from '~/components/MasonryColumns/MasonryProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export function CruciblesInfinite({ filters: filterOverrides, showEof = true }: Props) {
  const cruciblesFilters = useCrucibleFilters();
  const currentUser = useCurrentUser();
  const hasFilters = !!filterOverrides?.status;

  const filters = removeEmpty({ ...cruciblesFilters, ...filterOverrides });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { crucibles, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    useQueryCrucibles(debouncedFilters, { keepPreviousData: true });

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <>
      {isLoading ? (
        <CruciblesInfiniteSkeletonGrid />
      ) : !!crucibles.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGrid
            data={crucibles}
            render={CrucibleCard}
            itemId={(x) => x.id}
            empty={<CruciblesEmptyState hasFilters={hasFilters} isLoggedIn={!!currentUser} />}
          />
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isFetching}
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" style={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
          {!hasNextPage && showEof && <EndOfFeed />}
        </div>
      ) : (
        <CruciblesEmptyState hasFilters={hasFilters} isLoggedIn={!!currentUser} />
      )}
    </>
  );
}

type Props = { filters?: Partial<GetCruciblesInfiniteSchema>; showEof?: boolean };

/**
 * Skeleton grid for CruciblesInfinite loading state
 * Renders placeholder cards that match the masonry grid layout
 */
function CruciblesInfiniteSkeletonGrid() {
  const { columnCount, columnWidth, columnGap, rowGap, maxSingleColumnWidth } = useMasonryContext();

  // Generate skeleton cards (12 to fill typical viewport)
  const skeletonCount = 12;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${columnCount}, ${columnWidth}px)`,
        columnGap,
        rowGap,
        justifyContent: columnCount === 1 ? 'center' : undefined,
        maxWidth: columnCount === 1 ? maxSingleColumnWidth : undefined,
        margin: columnCount === 1 ? '0 auto' : undefined,
      }}
    >
      {Array.from({ length: skeletonCount }).map((_, i) => (
        <CrucibleCardSkeleton key={i} />
      ))}
    </div>
  );
}

type CruciblesEmptyStateProps = {
  hasFilters: boolean;
  isLoggedIn: boolean;
};

/**
 * Empty state component for crucibles discovery page
 * Shows different CTAs based on filter state and login status
 */
function CruciblesEmptyState({ hasFilters, isLoggedIn }: CruciblesEmptyStateProps) {
  if (hasFilters) {
    // User has filters applied but no results
    return (
      <Stack align="center" py={60}>
        <ThemeIcon size={80} radius={100} variant="light" color="gray">
          <IconSearch size={40} />
        </ThemeIcon>
        <Text fz={28} fw={600} ta="center">
          No crucibles found
        </Text>
        <Text c="dimmed" ta="center" maw={400}>
          Try adjusting your filters or check back later for new competitions
        </Text>
      </Stack>
    );
  }

  // No crucibles at all - encourage creation
  return (
    <Paper
      className="mx-auto max-w-lg rounded-xl border border-[#373a40]"
      bg="dark.6"
      p="xl"
    >
      <Stack align="center" gap="lg">
        <ThemeIcon size={80} radius={100} color="blue" variant="light">
          <IconTrophy size={40} />
        </ThemeIcon>
        <div className="text-center">
          <Text fz={28} fw={600} mb={8}>
            No Crucibles Yet
          </Text>
          <Text c="dimmed" maw={350}>
            Be the first to create a head-to-head competition! Submit your images, set prizes, and let the community vote.
          </Text>
        </div>
        {isLoggedIn ? (
          <Button
            component={Link}
            href="/crucibles/create"
            size="lg"
            leftSection={<IconPlus size={18} />}
            className="bg-blue-600 hover:bg-blue-500"
          >
            Create a Crucible
          </Button>
        ) : (
          <Button
            component={Link}
            href="/login?returnUrl=/crucibles/create"
            size="lg"
            leftSection={<IconPlus size={18} />}
            className="bg-blue-600 hover:bg-blue-500"
          >
            Sign in to Create
          </Button>
        )}
      </Stack>
    </Paper>
  );
}
