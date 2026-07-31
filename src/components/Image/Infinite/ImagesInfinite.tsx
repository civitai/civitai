import { Button, Center, Group, Loader, LoadingOverlay } from '@mantine/core';
import { getQueryKey } from '@trpc/react-query';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { isEqual } from 'lodash-es';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useEffect, useMemo, useRef } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useDomainColor } from '~/hooks/useDomainColor';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { SearchRetryBanner } from '~/components/EndOfFeed/SearchRetryBanner';
import { SEARCH_RETRY_MAX_ATTEMPTS, useSearchRetry } from '~/components/EndOfFeed/useSearchRetry';
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
import { queryClient, trpc } from '~/utils/trpc';

type ImagesInfiniteProps = {
  withTags?: boolean;
  filters?: ImagesQueryParamSchema;
  showEof?: boolean;
  renderItem?: React.ComponentType<MasonryRenderItemProps<ImageGetInfinite[number]>>;
  filterType?: 'images' | 'videos';
  showAds?: boolean;
  showEmptyCta?: boolean;
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
  disableStoreFilters = false,
  ...imageProviderProps
}: ImagesInfiniteProps) {
  const imageFilters = useImageFilters(filterType);
  const computedFilters = removeEmpty({
    ...(disableStoreFilters ? filterOverrides : { ...imageFilters, ...filterOverrides }),
    withTags,
  });
  // Stabilize identity so effects/query keys only fire on real content change.
  const filtersRef = useRef(computedFilters);
  if (!isEqual(filtersRef.current, computedFilters)) filtersRef.current = computedFilters;
  const filters = filtersRef.current;
  showEof = showEof && filters.period !== MetricTimeframe.AllTime;
  const infiniteQueryKey = useMemo(() => getQueryKey(trpc.image.getInfinite), []);

  const rawBrowsingLevel = useBrowsingLevelDebounced();
  const domainColor = useDomainColor();
  // On the green (SFW) domain we default to PG only on image/video feeds.
  // Users opt in to PG-13 via the feed filter; otherwise narrow the forced
  // domain cap (sfwBrowsingLevelsFlag = PG | PG-13) down to PG.
  // Read from merged `filters` (not just the Zustand store) so callers that
  // pass `filterOverrides` via URL params (Collection, UserMediaInfinite)
  // still drive the cap correctly.
  const capToPublic = domainColor === 'green' && !filters.includePG13;
  const browsingLevel = capToPublic
    ? Flags.intersection(rawBrowsingLevel, publicBrowsingLevelsFlag)
    : rawBrowsingLevel;
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
    { ...filters, browsingLevel, include: ['cosmetics'] },
    { keepPreviousData: true }
  );

  //#region [abort orphaned in-flight feed requests on filter change]
  // When filters change, the previous useInfiniteQuery observer
  // unsubscribes and a new one subscribes under the new key. Any request
  // already in flight for the old key keeps running server-side and holds a
  // heavy-image bulkhead slot (see request-bulkhead.ts + heavyProcedure in
  // src/server/trpc.ts) until it completes. Rapid filter changes stack these
  // orphans and produce TOO_MANY_REQUESTS on subsequent users. Cancelling
  // orphaned (observer-less) in-flight queries fires the AbortSignal that
  // tRPC plumbs into the handler ctx, freeing the slot immediately.
  useEffect(() => {
    queryClient.cancelQueries({
      queryKey: infiniteQueryKey,
      predicate: (q) => q.getObserversCount() === 0 && q.state.fetchStatus === 'fetching',
    });
  }, [filters, browsingLevel, infiniteQueryKey]);
  //#endregion

  const imagesCount = images.length;
  // Memoized so identity changes exactly when the query does — a fresh array here
  // would reset the attempt counter every render and flatten the backoff.
  const retryResetKey = useMemo(() => [filters, browsingLevel], [filters, browsingLevel]);
  const { isRetrying, isSlow, retryAttempt, retryDelay, countdownActive, handleRetry } =
    useSearchRetry({
      itemCount: imagesCount,
      isFetching,
      isError,
      refetch,
      fetchNextPage,
      infiniteQueryKey,
      resetKey: retryResetKey,
      debugRetryActive,
      debugDelayMs,
    });

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
      slow={isSlow}
    />
  );

  return (
    <>
      {!images.length && isFetching && !isRetrying ? (
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
