import { Button, Center, Group, Loader, LoadingOverlay } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import Link from 'next/link';
import { useEffect } from 'react';
import { ModelCard } from '~/components/Cards/ModelCard';
import { ModelCardContextProvider } from '~/components/Cards/ModelCardContext';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { ModelQueryParams, useModelFilters, useQueryModels } from '~/components/Model/model.utils';
import { NoContent } from '~/components/NoContent/NoContent';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ModelFilterSchema } from '~/providers/FiltersProvider';
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

  const filters = removeEmpty({
    ...(disableStoreFilters ? filterOverrides : { ...modelFilters, ...filterOverrides }),
    pending,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { models, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    useQueryModels(debouncedFilters);

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <ModelCardContextProvider
      useModelVersionRedirect={(filters?.baseModels ?? []).length > 0 || !!filters?.clubId}
    >
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!models.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryGrid
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
              <Center p="xl" sx={{ height: 36 }} mt="md">
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
