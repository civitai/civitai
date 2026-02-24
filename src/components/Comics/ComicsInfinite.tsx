import { Center, Loader, LoadingOverlay } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { useEffect } from 'react';
import { ComicCard } from '~/components/Cards/ComicCard';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import type { ComicGenre } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

type ComicFilters = {
  genre?: string;
  sort?: string;
  period?: string;
  followed?: boolean;
};

export function ComicsInfinite({ filters: filterOverrides = {}, showEof = false }: Props) {
  const [debouncedFilters, cancel] = useDebouncedValue(filterOverrides, 500);

  const { data, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    trpc.comics.getPublicProjects.useInfiniteQuery(
      {
        limit: 20,
        genre: debouncedFilters.genre as ComicGenre | undefined,
        sort: (debouncedFilters.sort as 'Newest' | 'MostFollowed' | 'MostChapters') || 'Newest',
        period: debouncedFilters.period as
          | 'Day'
          | 'Week'
          | 'Month'
          | 'Year'
          | 'AllTime'
          | undefined,
        followed: debouncedFilters.followed,
      },
      { getNextPageParam: (lastPage) => lastPage.nextCursor }
    );

  useEffect(() => {
    if (isEqual(filterOverrides, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filterOverrides]);

  const items = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!items.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGrid data={items} render={ComicCard} itemId={(x) => x.id} empty={<NoContent />} />
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
        <NoContent />
      )}
    </>
  );
}

type Props = {
  filters?: ComicFilters;
  showEof?: boolean;
};
