import { Button, Center, Group, Loader, LoadingOverlay } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { useEffect } from 'react';

import { ModelCard } from '~/components/Cards/ModelCard';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { AmbientModelCard } from '~/components/Model/Infinite/AmbientModelCard';
import { ModelQueryParams, useModelFilters, useQueryModels } from '~/components/Model/model.utils';
import { ModelFilterSchema } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NoContent } from '~/components/NoContent/NoContent';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import { ModelCardContextProvider } from '~/components/Cards/ModelCardContext';
import { InViewLoader } from '~/components/InView/InViewLoader';
import Link from 'next/link';

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
  const features = useFeatureFlags();
  const modelFilters = useModelFilters();

  const filters = removeEmpty(
    disableStoreFilters ? filterOverrides : { ...modelFilters, ...filterOverrides }
  );
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
          {features.modelCardV2 ? (
            <MasonryGrid
              data={models}
              render={ModelCard}
              itemId={(x) => x.id}
              empty={<NoContent />}
              withAds={showAds}
            />
          ) : (
            <MasonryColumns
              data={models}
              imageDimensions={(data) => {
                const width = data.images[0]?.width ?? 450;
                const height = data.images[0]?.height ?? 450;
                return { width, height };
              }}
              adjustHeight={({ imageRatio, height }) => height + (imageRatio >= 1 ? 60 : 0)}
              maxItemHeight={600}
              render={AmbientModelCard}
              itemId={(data) => data.id}
              withAds={showAds}
            />
          )}

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
