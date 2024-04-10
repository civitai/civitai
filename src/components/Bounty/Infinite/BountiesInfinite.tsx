import { GetInfiniteBountySchema } from '~/server/schema/bounty.schema';
import { Center, Loader, LoadingOverlay } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { useEffect } from 'react';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { removeEmpty } from '~/utils/object-helpers';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { BountyCard } from '~/components/Cards/BountyCard';
import { useBountyFilters, useQueryBounties } from '../bounty.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';

export function BountiesInfinite({ filters: filterOverrides, showEof = true }: Props) {
  const bountiesFilters = useBountyFilters();

  const filters = removeEmpty({ ...bountiesFilters, ...filterOverrides });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { bounties, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    useQueryBounties(debouncedFilters, { keepPreviousData: true });

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
      ) : !!bounties.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGrid
            data={bounties}
            render={BountyCard}
            itemId={(x) => x.id}
            empty={<NoContent />}
          />
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isFetching}
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

type Props = { filters?: Partial<GetInfiniteBountySchema>; showEof?: boolean };
