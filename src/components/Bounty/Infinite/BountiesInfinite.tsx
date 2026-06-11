import type { GetInfiniteBountySchema } from '~/server/schema/bounty.schema';
import { Center, Loader, LoadingOverlay } from '@mantine/core';
import { isEqual } from 'lodash-es';
import { useRef } from 'react';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import { removeEmpty } from '~/utils/object-helpers';
import { MasonryGridVirtual } from '~/components/MasonryColumns/MasonryGridVirtual';
import { BountyCard } from '~/components/Cards/BountyCard';
import { useBountyFilters, useQueryBounties } from '../bounty.utils';
import { InViewLoader } from '~/components/InView/InViewLoader';

export function BountiesInfinite({ filters: filterOverrides, showEof = true }: Props) {
  const bountiesFilters = useBountyFilters();

  const computedFilters = removeEmpty({ ...bountiesFilters, ...filterOverrides });
  // Stabilize identity so query keys only update on real content change.
  const filtersRef = useRef(computedFilters);
  if (!isEqual(filtersRef.current, computedFilters)) filtersRef.current = computedFilters;
  const filters = filtersRef.current;

  const { bounties, fetchNextPage, hasNextPage, isRefetching, isFetching } = useQueryBounties(
    filters,
    { keepPreviousData: true }
  );

  return (
    <>
      {!bounties.length && isFetching ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!bounties.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGridVirtual
            data={bounties}
            render={BountyCard}
            itemId={(x) => x.id}
            empty={<NoContent />}
            aspectRatio="square"
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

type Props = { filters?: Partial<GetInfiniteBountySchema>; showEof?: boolean };
