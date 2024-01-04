import { Center, Loader, LoadingOverlay, Stack, Text, ThemeIcon } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconCloudOff } from '@tabler/icons-react';
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

type InfiniteModelsProps = {
  filters?: Partial<Omit<ModelQueryParams, 'view'> & Omit<ModelFilterSchema, 'view'>>;
  showEof?: boolean;
};

export function ModelsInfinite({
  filters: filterOverrides = {},
  showEof = false,
}: InfiniteModelsProps) {
  const features = useFeatureFlags();
  const modelFilters = useModelFilters();

  const filters = removeEmpty({ ...modelFilters, ...filterOverrides });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { models, isLoading, fetchNextPage, hasNextPage, isRefetching } = useQueryModels(
    debouncedFilters,
    { keepPreviousData: true }
  );

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <ModelCardContextProvider
      useModelVersionRedirect={(filters?.baseModels ?? []).length > 0 || filters?.clubId}
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
            />
          ) : (
            <MasonryColumns
              data={models}
              imageDimensions={(data) => {
                const width = data.image?.width ?? 450;
                const height = data.image?.height ?? 450;
                return { width, height };
              }}
              adjustHeight={({ imageRatio, height }) => height + (imageRatio >= 1 ? 60 : 0)}
              maxItemHeight={600}
              render={AmbientModelCard}
              itemId={(data) => data.id}
            />
          )}

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
        <Stack align="center" py="lg">
          <ThemeIcon size={128} radius={100}>
            <IconCloudOff size={80} />
          </ThemeIcon>
          <Text size={32} align="center">
            No results found
          </Text>
          <Text align="center">
            {"Try adjusting your search or filters to find what you're looking for"}
          </Text>
        </Stack>
      )}
    </ModelCardContextProvider>
  );
}
