import { Center, Loader, LoadingOverlay } from '@mantine/core';

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
import { InViewLoader } from '~/components/InView/InViewLoader';

export function CollectionsInfinite({
  filters: filterOverrides = {},
  showEof = false,
  enabled = true,
}: Props) {
  const collectionFilters = useCollectionFilters();

  const filters = removeEmpty({ ...collectionFilters, ...filterOverrides });

  const { collections, isLoading, isRefetching, fetchNextPage, hasNextPage } = useQueryCollections(
    filters,
    { enabled, keepPreviousData: true }
  );

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!collections.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={20} />
          <UniformGrid
            data={collections}
            render={CollectionCard}
            itemId={(x) => x.id}
            empty={<NoContent />}
          />
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
