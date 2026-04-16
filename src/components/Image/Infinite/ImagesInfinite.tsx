import { Button, Center, Group, Loader, LoadingOverlay } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { isEqual } from 'lodash-es';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { SearchRetryBanner } from '~/components/EndOfFeed/SearchRetryBanner';
import { FeedWrapper } from '~/components/Feed/FeedWrapper';
import type { ImagesQueryParamSchema } from '~/components/Image/image.utils';
import { useImageFilters, useQueryImages } from '~/components/Image/image.utils';
import { ImagesCardMemoized } from '~/components/Image/Infinite/ImagesCard';
import type { ImagesContextState } from '~/components/Image/Providers/ImagesProvider';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import type { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { NoContent } from '~/components/NoContent/NoContent';
import type { ImageGetInfinite } from '~/types/router';
import { removeEmpty } from '~/utils/object-helpers';

const SEARCH_RETRY_MAX_ATTEMPTS = 10;
const SEARCH_RETRY_MAX_DELAY_MS = 60_000;
const SEARCH_RETRY_BASE_DELAY_MS = 2000;

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
} & Pick<ImagesContextState, 'collectionId' | 'judgeInfo'>;

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
  ...imageProviderProps
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
  const {
    images,
    fetchNextPage,
    refetch,
    hasNextPage,
    isRefetching,
    isFetching,
    isError,
    debugRetryActive,
    debugDelayMs,
  } = useQueryImages(
    { ...debouncedFilters, browsingLevel, include: ['cosmetics'] },
    { keepPreviousData: true }
  );

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  //#region [search retry] — any backend failure (Meili, API, network)
  const [retryAttempt, setRetryAttempt] = useState(0);
  const imagesCount = images.length;
  const prevImagesCount = useRef(imagesCount);

  // Reset retry attempt counter whenever new items successfully load.
  useEffect(() => {
    if (imagesCount > prevImagesCount.current) {
      prevImagesCount.current = imagesCount;
      if (retryAttempt !== 0) setRetryAttempt(0);
    } else {
      prevImagesCount.current = imagesCount;
    }
  }, [imagesCount, retryAttempt]);

  // Reset retry state when filters change (new query = fresh slate).
  useEffect(() => {
    setRetryAttempt(0);
  }, [debouncedFilters, browsingLevel]);

  const handleRetry = useCallback(() => {
    // After exhaustion, manual retry resets the attempt counter for a fresh cycle.
    setRetryAttempt((prev) => (prev >= SEARCH_RETRY_MAX_ATTEMPTS ? 0 : prev + 1));
    // In debug mode we deliberately skip the real fetch so the retry UI can
    // cycle faithfully — otherwise real fetches succeed, more images load,
    // and the retry counter resets every cycle.
    if (debugRetryActive) return;
    // Use refetch when there are no pages yet (initial-load failure);
    // fetchNextPage retries the next page when prior pages already succeeded.
    if (imagesCount === 0) refetch();
    else fetchNextPage();
  }, [fetchNextPage, refetch, debugRetryActive, imagesCount]);

  const isRetrying = isError || debugRetryActive;
  const baseDelay = debugRetryActive ? debugDelayMs : SEARCH_RETRY_BASE_DELAY_MS;
  const retryDelay = isRetrying
    ? Math.min(baseDelay * Math.pow(2, retryAttempt), SEARCH_RETRY_MAX_DELAY_MS)
    : 0;
  //#endregion

  // In debug mode we block real fetches so isFetching never toggles — treat it
  // as countdown-active always. For real errors, the countdown pauses while a
  // retry request is in flight so we don't queue up concurrent duplicates.
  const countdownActive = debugRetryActive || !isFetching;

  const retryBanner = (
    <SearchRetryBanner
      delayMs={retryDelay}
      attempt={retryAttempt + 1}
      maxAttempts={SEARCH_RETRY_MAX_ATTEMPTS}
      onRetry={handleRetry}
      debugMode={debugRetryActive}
      browsingLevel={browsingLevel}
      countdownActive={countdownActive}
      isInitialLoad={imagesCount === 0}
    />
  );

  return (
    <>
      {!images.length && isFetching ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !images.length && isRetrying ? (
        retryBanner
      ) : !!images.length || hasNextPage ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />

          <ImagesProvider images={images} {...imageProviderProps}>
            <MasonryColumnsVirtual
              data={images}
              imageDimensions={(data) => {
                const width = data?.width ? data.width : 450;
                const height = data?.height ? data.height : 450;
                return { width, height };
              }}
              adjustHeight={({ height }) => {
                const imageHeight = Math.max(Math.min(height, 600), 150);
                return imageHeight + 38;
              }}
              maxItemHeight={600}
              render={MasonryItem ?? ImagesCardMemoized}
              itemId={(data) => data.id}
              withAds={showAds}
            />
          </ImagesProvider>
          {isRetrying ? (
            retryBanner
          ) : hasNextPage ? (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isFetching}
              // Forces a re-render whenever the amount of images fetched changes. Forces load-more if available.
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" style={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          ) : null}
          {!hasNextPage && !isRetrying && showEof && <EndOfFeed />}
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
                <Button radius="xl">Generate</Button>
              </Link>
            </Group>
          )}
        </NoContent>
      )}
    </>
  );
}
