import { Center, Loader, LoadingOverlay, Stack, Text, ThemeIcon } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { MetricTimeframe } from '@prisma/client';
import { IconCloudOff } from '@tabler/icons-react';
import { debounce } from 'lodash-es';
import { useEffect, useMemo } from 'react';
import { useInView } from 'react-intersection-observer';

import { ModelCard } from '~/components/Cards/ModelCard';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { AmbientModelCard } from '~/components/Model/Infinite/ModelCard';
import { ModelQueryParams, useModelFilters, useQueryModels } from '~/components/Model/model.utils';
import { ModelFilterSchema } from '~/providers/FiltersProvider';
import { ModelGetAll } from '~/types/router';
import { removeEmpty } from '~/utils/object-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

type InfiniteModelsProps = {
  filters?: Partial<Omit<ModelQueryParams, 'view'> & Omit<ModelFilterSchema, 'view'>>;
  showEof?: boolean;
  renderItem?: React.ComponentType<MasonryRenderItemProps<ModelGetAll['items'][number]>>;
};

export function ModelsInfinite({
  filters: filterOverrides = {},
  showEof = false,
  renderItem,
}: InfiniteModelsProps) {
  const features = useFeatureFlags();
  const { ref, inView } = useInView();
  const modelFilters = useModelFilters();
  const RenderItem = renderItem ?? features.modelCardV2 ? ModelCard : AmbientModelCard;

  const filters = removeEmpty({ ...modelFilters, ...filterOverrides });
  showEof = showEof && filters.period !== MetricTimeframe.AllTime;
  const [debouncedFilters] = useDebouncedValue(filters, 500);

  const { models, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    useQueryModels(debouncedFilters, { keepPreviousData: true });
  const debouncedFetchNextPage = useMemo(() => debounce(fetchNextPage, 500), [fetchNextPage]);

  // #region [infinite data fetching]
  useEffect(() => {
    if (inView && !isFetching) {
      debouncedFetchNextPage();
    }
  }, [debouncedFetchNextPage, inView, isFetching]);
  // #endregion

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!models.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <MasonryColumns
            data={models}
            imageDimensions={(data) => {
              const width = data.image?.width ?? 450;
              const height = data.image?.height ?? 450;
              return { width, height };
            }}
            adjustHeight={({ imageRatio, height }) => height + (imageRatio >= 1 ? 60 : 0)}
            maxItemHeight={600}
            render={RenderItem}
            itemId={(data) => data.id}
          />
          {hasNextPage && !isLoading && !isRefetching && (
            <Center ref={ref} sx={{ height: 36 }} mt="md">
              {inView && <Loader />}
            </Center>
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
    </>
  );
}
