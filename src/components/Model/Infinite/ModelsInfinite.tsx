import { Button, Center, Group, Loader, LoadingOverlay } from '@mantine/core';
import { isEqual } from 'lodash-es';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRef } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ModelCardContextProvider } from '~/components/Cards/ModelCardContext';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryGridVirtual } from '~/components/MasonryColumns/MasonryGridVirtual';
import type { ModelQueryParams } from '~/components/Model/model.utils';
import { useModelFilters, useQueryModels } from '~/components/Model/model.utils';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ModelFilterSchema } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';

type InfiniteModelsProps = {
  filters?: Partial<Omit<ModelQueryParams, 'view'> & Omit<ModelFilterSchema, 'view'>>;
  disableStoreFilters?: boolean;
  showEof?: boolean;
  showAds?: boolean;
  showEmptyCta?: boolean;
};

export function ModelsInfinite({
  filters: filterOverrides = {},
  showEof = false,
  disableStoreFilters = false,
  showAds,
  showEmptyCta,
}: InfiniteModelsProps) {
  const modelFilters = useModelFilters();
  const currentUser = useCurrentUser();

  const pending = currentUser !== null && filterOverrides.username === currentUser.username;

  const computedFilters = removeEmpty({
    ...(disableStoreFilters ? filterOverrides : { ...modelFilters, ...filterOverrides }),
    pending,
  });
  // Stabilize identity so query keys only update on real content change.
  const filtersRef = useRef(computedFilters);
  if (!isEqual(filtersRef.current, computedFilters)) filtersRef.current = computedFilters;
  const filters = filtersRef.current;

  const browsingLevel = useBrowsingLevelDebounced();
  const { models, fetchNextPage, hasNextPage, isRefetching, isFetching } = useQueryModels({
    ...filters,
    browsingLevel,
  });

  return (
    <ModelCardContextProvider
      useModelVersionRedirect={(filters?.baseModels ?? []).length > 0}
      activeBaseModels={filters?.baseModels}
    >
      {!models.length && isFetching ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!models.length ? (
        <div className="relative">
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGridVirtual
            data={models}
            render={ModelCard}
            itemId={(x) => x.id}
            empty={<NoContent />}
            withAds={showAds}
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
        <NoContent py="lg">
          {showEmptyCta && (
            <Group>
              <Link href="/models/create">
                <Button variant="default" radius="xl">
                  Upload a Model
                </Button>
              </Link>
              <Link href="/models/train">
                <Button radius="xl">Train a LoRA</Button>
              </Link>
            </Group>
          )}
        </NoContent>
      )}
    </ModelCardContextProvider>
  );
}
