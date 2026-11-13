import { useRef } from 'react';
import {
  normalizeFeedQuery,
  searchPeriodChange,
} from '~/components/Image/Infinite/image-feed-search';
import { useFeedImageItems, useImageQueryParams } from '~/components/Image/image.utils';
import { withPlaceholderData } from '~/hooks/trpcHelpers';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

const idleInput: SemanticImageSearchInput = { query: '', browsingLevel: 0, limit: 50 };

/** The feed's search text, when this viewer has feed search; otherwise undefined. */
export function useImageFeedSearchQuery() {
  const features = useFeatureFlags();
  const { query } = useImageQueryParams();
  if (!features.feedSearch) return undefined;
  return normalizeFeedQuery(query.query);
}

// The feed period a search replaced, kept across reloads until it is given back.
const SAVED_PERIOD_KEY = 'image-feed-search-saved-period';

function readSavedPeriod() {
  try {
    const value = localStorage.getItem(SAVED_PERIOD_KEY);
    return Object.values(MetricTimeframe).find((period) => period === value);
  } catch {
    return undefined;
  }
}

function writeSavedPeriod(period: MetricTimeframe | undefined) {
  try {
    if (period) localStorage.setItem(SAVED_PERIOD_KEY, period);
    else localStorage.removeItem(SAVED_PERIOD_KEY);
  } catch {
    // Without storage the period is still reset; it just can't be given back.
  }
}

/**
 * Applies `searchPeriodChange` to the saved images-feed period. Returns the period the feed should
 * use on the render before that write lands, so the first request already has it; a `?period=` on
 * the URL outranks both, as it does in `useImageFilters`.
 */
export function useSearchPeriod(searching: boolean) {
  const period = useFiltersContext((state) => state.images.period);
  const setImageFilters = useFiltersContext((state) => state.setImageFilters);
  const { query: params } = useImageQueryParams();
  const wasSearching = useRef(false);

  const read = () => ({
    searching,
    wasSearching: wasSearching.current,
    period,
    savedPeriod: typeof window === 'undefined' ? undefined : readSavedPeriod(),
  });

  // A layout effect, so the write lands before the feed's query subscribes.
  useIsomorphicLayoutEffect(() => {
    const change = searchPeriodChange(read());
    wasSearching.current = searching;
    if (!change) return;
    writeSavedPeriod(change.savedPeriod);
    if (change.write) setImageFilters({ period: change.write });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching]);

  return params.period ? undefined : searchPeriodChange(read())?.write;
}

/** The images feed answered by the semantic search, in the shape the feed renders. */
export function useSemanticImageFeed(input: SemanticImageSearchInput | undefined) {
  const { data, ...rest } = trpc.semanticImageSearch.search.useInfiniteQuery(input ?? idleInput, {
    enabled: !!input,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...withPlaceholderData({ keepPreviousData: true }),
    // The feed's retry banner and its fall-back to the plain feed drive every attempt.
    retry: 0,
    trpc: { context: { skipBatch: true }, abortOnUnmount: true },
  });

  const { items } = useFeedImageItems(data?.pages, { isRefetching: rest.isRefetching });

  return { ...rest, images: items, correctedQuery: data?.pages[0]?.correctedQuery };
}
