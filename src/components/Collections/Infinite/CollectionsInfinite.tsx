import { Center, Loader, LoadingOverlay } from '@mantine/core';
import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';

import { CollectionCard } from '~/components/Cards/CollectionCard';
import {
  useCollectionFilters,
  useQueryCollections,
} from '~/components/Collections/collection.utils';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { UniformGrid } from '~/components/MasonryColumns/UniformGrid';
import { NoContent } from '~/components/NoContent/NoContent';
import { GetAllCollectionsInfiniteSchema } from '~/server/schema/collection.schema';
import { removeEmpty } from '~/utils/object-helpers';

export function CollectionsInfinite({
  filters: filterOverrides = {},
  showEof = false,
  enabled = true,
}: Props) {
  const { ref, inView } = useInView();
  const collectionFilters = useCollectionFilters();

  const filters = removeEmpty({ ...collectionFilters, ...filterOverrides });

  const { collections, isLoading, isFetching, isRefetching, fetchNextPage, hasNextPage } =
    useQueryCollections(filters, { enabled, keepPreviousData: true });

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && !isFetching) {
      fetchNextPage?.();
    }
  }, [fetchNextPage, inView, isFetching]);
  // #endregion

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!collections.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <UniformGrid
            data={collections}
            render={CollectionCard}
            itemId={(x) => x.id}
            empty={<NoContent />}
          />
          {hasNextPage && !isLoading && !isRefetching && (
            <Center ref={ref} sx={{ height: 36 }} mt="md">
              {inView && <Loader />}
            </Center>
          )}
          {!hasNextPage && showEof && <EndOfFeed />}
        </div>
      ) : (
        <NoContent message="Try adjusting your search or filters to find what you're looking for" />
      )}
    </>
  );
}

type Props = {
  filters?: Partial<GetAllCollectionsInfiniteSchema>;
  showEof?: boolean;
  enabled?: boolean;
};
