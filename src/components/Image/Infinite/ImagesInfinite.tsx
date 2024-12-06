import { Button, Center, Group, Loader, LoadingOverlay } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { isEqual } from 'lodash-es';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useEffect } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { FeedWrapper } from '~/components/Feed/FeedWrapper';
import {
  ImagesQueryParamSchema,
  useImageFilters,
  useQueryImages,
} from '~/components/Image/image.utils';
import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { NoContent } from '~/components/NoContent/NoContent';
import { ImageGetInfinite } from '~/types/router';
import { removeEmpty } from '~/utils/object-helpers';

type ImagesInfiniteProps = {
  withTags?: boolean;
  filters?: ImagesQueryParamSchema;
  showEof?: boolean;
  renderItem?: React.ComponentType<MasonryRenderItemProps<ImageGetInfinite[number]>>;
  filterType?: 'images' | 'videos';
  showAds?: boolean;
  showEmptyCta?: boolean;
  useIndex?: boolean;
  disableStoreFilters?: boolean;
};

export default function ImagesInfinite(props: ImagesInfiniteProps) {
  return (
    <FeedWrapper>
      <ImagesInfiniteContent {...props} />
    </FeedWrapper>
  );
}

export function ImagesInfiniteContent({
  withTags,
  filters: filterOverrides = {},
  showEof = false,
  renderItem: MasonryItem,
  filterType = 'images',
  showAds,
  showEmptyCta,
  useIndex,
  disableStoreFilters = false,
}: ImagesInfiniteProps) {
  const imageFilters = useImageFilters(filterType);
  const filters = removeEmpty({
    ...(disableStoreFilters ? filterOverrides : { ...imageFilters, ...filterOverrides }),
    useIndex,
    withTags,
  });
  showEof = showEof && filters.period !== MetricTimeframe.AllTime;
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const browsingLevel = useBrowsingLevelDebounced();
  const { images, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    useQueryImages(
      { ...debouncedFilters, browsingLevel, include: ['cosmetics'] },
      { keepPreviousData: true }
    );

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !!images.length || hasNextPage ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />

          <ImagesProvider images={images}>
            <MasonryColumns
              data={images}
              imageDimensions={(data) => {
                const width = data?.width ?? 450;
                const height = data?.height ?? 450;
                return { width, height };
              }}
              adjustHeight={({ height }) => {
                const imageHeight = Math.max(Math.min(height, 600), 150);
                return imageHeight + 38;
              }}
              maxItemHeight={600}
              render={MasonryItem ?? ImagesCard}
              itemId={(data) => data.id}
              withAds={showAds}
            />
          </ImagesProvider>
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isFetching}
              // Forces a re-render whenever the amount of images fetched changes. Forces load-more if available.
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
              <Link href="/posts/create">
                <Button variant="default" radius="xl">
                  Post Media
                </Button>
              </Link>
              <Link href="/generate">
                <Button radius="xl">Generate Images</Button>
              </Link>
            </Group>
          )}
        </NoContent>
      )}
    </>
  );
}
