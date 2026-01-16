import type { GetCruciblesInfiniteSchema } from '~/server/schema/crucible.schema';
import { Center, Loader, LoadingOverlay } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { useEffect } from 'react';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { removeEmpty } from '~/utils/object-helpers';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { CrucibleCard } from '~/components/Cards/CrucibleCard';
import { useCrucibleFilters, useQueryCrucibles } from './crucible.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';

export function CruciblesInfinite({ filters: filterOverrides, showEof = true }: Props) {
  const cruciblesFilters = useCrucibleFilters();

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
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!crucibles.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGrid
            data={crucibles}
            render={CrucibleCard}
            itemId={(x) => x.id}
            empty={<NoContent />}
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
        <NoContent />
      )}
    </>
  );
}

type Props = { filters?: Partial<GetCruciblesInfiniteSchema>; showEof?: boolean };
