import { LoadingOverlay, Center, Loader, Group, Button } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { useEffect } from 'react';

import { ImagesCard } from '~/components/Image/Infinite/ImagesCard';
import { removeEmpty } from '~/utils/object-helpers';
import { ImageSort } from '~/server/common/enums';
import { useImageFilters, useQueryImages } from '~/components/Image/image.utils';
import { MasonryColumns } from '~/components/MasonryColumns/MasonryColumns';
import { MediaType, MetricTimeframe, ReviewReactions } from '@prisma/client';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { IsClient } from '~/components/IsClient/IsClient';
import { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { ImageGetInfinite } from '~/types/router';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import Link from 'next/link';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { FeedWrapper } from '~/components/Feed/FeedWrapper';
import { IntersectionOptions } from 'react-intersection-observer';

type ImageFilters = {
  modelId?: number;
  modelVersionId?: number;
  postId?: number;
  collectionId?: number;
  username?: string;
  reviewId?: number;
  prioritizedUserIds?: number[];
  period?: MetricTimeframe;
  sort?: ImageSort;
  reactions?: ReviewReactions[];
  types?: MediaType[];
  withMeta?: boolean;
  followed?: boolean;
  hidden?: boolean;
  fromPlatform?: boolean;
  pending?: boolean;
};

type ImagesInfiniteProps = {
  withTags?: boolean;
  filters?: ImageFilters;
  showEof?: boolean;
  renderItem?: React.ComponentType<MasonryRenderItemProps<ImageGetInfinite[number]>>;
  filterType?: 'images' | 'videos';
  showAds?: boolean;
  showEmptyCta?: boolean;
  nextPageLoaderOptions?: IntersectionOptions;
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
  nextPageLoaderOptions,
}: ImagesInfiniteProps) {
  const imageFilters = useImageFilters(filterType);
  const filters = removeEmpty({ ...imageFilters, ...filterOverrides, withTags });
  showEof = showEof && filters.period !== MetricTimeframe.AllTime;
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const browsingLevel = useBrowsingLevelDebounced();
  const { images, isLoading, fetchNextPage, hasNextPage, isRefetching, isFetching } =
    useQueryImages({ ...debouncedFilters, browsingLevel }, { keepPreviousData: true });

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <IsClient>
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
              maxItemHeight={600}
              render={MasonryItem ?? ImagesCard}
              itemId={(data) => data.id}
              withAds={showAds}
            />
          </ImagesProvider>
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isFetching && hasNextPage}
              // Forces a re-render whenever the amount of images fetched changes. Forces load-more if available.
              style={{ gridColumn: '1/-1' }}
              inViewOptions={nextPageLoaderOptions}
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
    </IsClient>
  );
}
