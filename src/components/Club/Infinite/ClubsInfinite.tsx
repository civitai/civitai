import { Center, Loader, LoadingOverlay } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { useEffect } from 'react';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { removeEmpty } from '~/utils/object-helpers';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useClubFilters, useQueryClubs } from '~/components/Club/club.utils';
import { ClubCard } from '~/components/Club/ClubCard';
import { GetInfiniteClubSchema } from '~/server/schema/club.schema';

export function ClubsInfinite({ filters: filterOverrides, showEof = true }: Props) {
  const clubsFilters = useClubFilters();

  const filters = removeEmpty({ ...clubsFilters, ...filterOverrides });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { clubs, isLoading, fetchNextPage, hasNextPage, isRefetching } = useQueryClubs(
    debouncedFilters,
    { keepPreviousData: true }
  );

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!clubs.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGrid data={clubs} render={ClubCard} itemId={(x) => x.id} empty={<NoContent />} />
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isRefetching}
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" sx={{ height: 36 }} mt="md">
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

type Props = { filters?: Partial<GetInfiniteClubSchema>; showEof?: boolean };
