import { Button, Center, Group, Loader, LoadingOverlay, Text } from '@mantine/core';
import { getQueryKey } from '@trpc/react-query';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { isEqual } from 'lodash-es';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type { GetInfiniteImagesInput } from '~/server/schema/image.schema';
import { useDomainColor } from '~/hooks/useDomainColor';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { SearchRetryBanner } from '~/components/EndOfFeed/SearchRetryBanner';
import { FeedWrapper } from '~/components/Feed/FeedWrapper';
import type { ImagesQueryParamSchema } from '~/components/Image/image.utils';
import { useImageFilters, useQueryImages } from '~/components/Image/image.utils';
import { ImagesCardMemoized } from '~/components/Image/Infinite/ImagesCard';
import { adjustImagesCardHeight } from '~/components/Image/Infinite/images-card-footer';
import type { ImagesContextState } from '~/components/Image/Providers/ImagesProvider';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import type { MasonryRenderItemProps } from '~/components/MasonryColumns/masonry.types';
import { getImagesSpanMaxHeight } from '~/components/Image/Infinite/images-span';
import { MasonryColumnsVirtual } from '~/components/MasonryColumns/MasonryColumnsVirtual';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NoContent } from '~/components/NoContent/NoContent';
import { toSemanticImageSearchInput } from '~/components/Image/Infinite/image-feed-search';
import { ImageFeedSearchSummary } from '~/components/Image/Infinite/ImageFeedSearchSummary';
import {
  useImageFeedSearchQuery,
  useSemanticImageFeed,
} from '~/components/Image/Infinite/useImageFeedSearch';
import type { ImageGetInfinite } from '~/types/router';
import { removeEmpty } from '~/utils/object-helpers';
import { queryClient, trpc } from '~/utils/trpc';

const SEARCH_RETRY_MAX_ATTEMPTS = 10;
const SEARCH_RETRY_MAX_DELAY_MS = 60_000;
const SEARCH_RETRY_BASE_DELAY_MS = 2000;
// Slow-fetch thresholds. Bad pods in production can leave a request hanging
// for tens of seconds before failing, so we show a "taking a while" banner
// after SLOW_THRESHOLD_MS and abort at ABORT_THRESHOLD_MS to force a retry.
const SEARCH_SLOW_THRESHOLD_MS = 3_000;
const SEARCH_ABORT_THRESHOLD_MS = 8_000;

type ImagesInfiniteProps = {
  withTags?: boolean;
  /**
   * `ImagesQueryParamSchema` is the URL-param shape, and a couple of API filters are
   * not URL-serialisable — an array of objects has no query-string form. They are named
   * here rather than added to that schema, and rather than smuggled past the prop with
   * a spread, which is how this call site used to typecheck: a spread defeats excess
   * property checking, so a misspelled key silently sent nothing.
   */
  filters?: ImagesQueryParamSchema & Partial<Pick<GetInfiniteImagesInput, 'hubExcludedSources'>>;
  showEof?: boolean;
  renderItem?: React.ComponentType<MasonryRenderItemProps<ImageGetInfinite[number]>>;
  filterType?: 'images' | 'videos';
  showAds?: boolean;
  showEmptyCta?: boolean;
  emptyMessage?: string;
  disableStoreFilters?: boolean;
  /** Let a 16:9-or-wider image cover two columns (still needs the flag). Off unless a page asks. */
  landscapeSpan?: boolean;
  hideHatTurf?: boolean;
  /** Answer a `?query=` from the semantic search (Search v3, behind `feedSearch`). */
  searchable?: boolean;
} & Pick<ImagesContextState, 'collectionId' | 'judgeInfo' | 'judgingCategories'>;

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
  emptyMessage,
  disableStoreFilters = false,
  landscapeSpan,
  searchable,
  ...imageProviderProps
}: ImagesInfiniteProps) {
  const features = useFeatureFlags();
  const imageFilters = useImageFilters(filterType);
  const { query: rawSearchQuery, ...computedFilters } = removeEmpty({
    ...(disableStoreFilters ? filterOverrides : { ...imageFilters, ...filterOverrides }),
    withTags,
  });
  const featureSearchQuery = useImageFeedSearchQuery();
  const searchQuery = searchable && rawSearchQuery ? featureSearchQuery : undefined;
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
  const searchInput = useMemo(
    () =>
      searchQuery
        ? toSemanticImageSearchInput({ query: searchQuery, filters, browsingLevel })
        : undefined,
    [searchQuery, filters, browsingLevel]
  );
  const search = useSemanticImageFeed(searchInput);
  // A search that fails falls back to the plain feed with a banner, never an empty page.
  const searchFailed = !!searchInput && search.isError;
  const searching = !!searchInput && !searchFailed;
  const feed = useQueryImages(
    { ...filters, browsingLevel, include: ['cosmetics'] },
    { keepPreviousData: true, enabled: !searching }
  );
  const { debugRetryActive, debugDelayMs } = feed;
  const { images, fetchNextPage, refetch, hasNextPage, isRefetching, isFetching, isError } =
    searching ? search : feed;

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
  }, [filters, browsingLevel]);
  //#endregion

  //#region [slow fetch] — bad pods hang; show banner at 5s, abort at 15s
  const [isSlow, setIsSlow] = useState(false);

  // Depend on retryAttempt so every retry restarts the slow timer even when
  // isFetching doesn't visibly transition through false (cancel + refetch in
  // quick succession can collapse into a single `true` state from React's
  // perspective, leaving the effect stale).
  useEffect(() => {
    // A cold semantic search legitimately takes several seconds; aborting it would only start it over.
    if (!isFetching || searching) {
      setIsSlow(false);
      return;
    }
    setIsSlow(false);
    const t = setTimeout(() => setIsSlow(true), SEARCH_SLOW_THRESHOLD_MS);
    return () => clearTimeout(t);
  }, [isFetching, retryAttempt, searching]);
  //#endregion

  const handleRetry = useCallback(async () => {
    const wasSlow = isSlow;
    if (wasSlow) setIsSlow(false);
    // After exhaustion, manual retry resets the attempt counter for a fresh cycle.
    setRetryAttempt((prev) => (prev >= SEARCH_RETRY_MAX_ATTEMPTS ? 0 : prev + 1));
    // In debug mode we deliberately skip the real fetch so the retry UI can
    // cycle faithfully — otherwise real fetches succeed, more images load,
    // and the retry counter resets every cycle.
    if (debugRetryActive) return;
    // Slow-fetch path: await cancel BEFORE firing the replacement fetch.
    // Without await, React Query can queue the new fetch behind the in-flight
    // one instead of aborting it, so both end up running to completion.
    // cancelQueries also does NOT surface as an error, so we have to kick the
    // replacement fetch off ourselves.
    if (wasSlow) {
      await queryClient.cancelQueries({ queryKey: infiniteQueryKey });
    }
    // Use refetch when there are no pages yet (initial-load failure);
    // fetchNextPage retries the next page when prior pages already succeeded.
    if (imagesCount === 0) refetch();
    else fetchNextPage();
  }, [fetchNextPage, refetch, debugRetryActive, imagesCount, isSlow, infiniteQueryKey]);

  const isRetrying = isError || debugRetryActive || isSlow;
  const baseDelay = debugRetryActive ? debugDelayMs : SEARCH_RETRY_BASE_DELAY_MS;
  const retryDelay = isSlow
    ? SEARCH_ABORT_THRESHOLD_MS - SEARCH_SLOW_THRESHOLD_MS
    : isError || debugRetryActive
    ? Math.min(baseDelay * Math.pow(2, retryAttempt), SEARCH_RETRY_MAX_DELAY_MS)
    : 0;

  // In debug mode we block real fetches so isFetching never toggles — treat it
  // as countdown-active always. For real errors, the countdown pauses while a
  // retry request is in flight so we don't queue up concurrent duplicates.
  // When slow, we force the countdown on so the abort timer displays.
  const countdownActive = debugRetryActive || !isFetching || isSlow;

  const retryBanner = (
    <SearchRetryBanner
      delayMs={retryDelay}
      attempt={retryAttempt + 1}
      maxAttempts={SEARCH_RETRY_MAX_ATTEMPTS}
      onRetry={handleRetry}
      debugMode={debugRetryActive}
      countdownActive={countdownActive}
      isInitialLoad={imagesCount === 0}
      slow={isSlow}
    />
  );

  return (
    <>
      {searchInput && (
        <ImageFeedSearchSummary
          query={searchInput.query ?? ''}
          correctedQuery={searching ? search.correctedQuery : undefined}
          filters={filters}
          failed={searchFailed}
          onRetry={() => search.refetch()}
        />
      )}
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
              adjustHeight={(args) => adjustImagesCardHeight(args, !!MasonryItem)}
              maxItemHeight={600}
              render={MasonryItem ?? ImagesCardMemoized}
              itemId={(data) => data.id}
              withAds={showAds}
              spanLandscapeMaxHeight={getImagesSpanMaxHeight({
                optedIn: landscapeSpan,
                flagOn: features.masonryLandscapeSpan,
                customCard: !!MasonryItem,
              })}
              hasMore={hasNextPage && !isRetrying}
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
          {!hasNextPage && !isRetrying && searching && (
            <Text c="dimmed" ta="center" size="sm" py="xl">
              That&rsquo;s every match. Try other words, or clear the search to see the whole feed.
            </Text>
          )}
          {!hasNextPage && !isRetrying && showEof && !searching && <EndOfFeed />}
        </div>
      ) : (
        <NoContent
          py="lg"
          message={
            searching
              ? 'No images match this search. Try other words, or remove a filter.'
              : emptyMessage
          }
        >
          {showEmptyCta && !searching && (
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
