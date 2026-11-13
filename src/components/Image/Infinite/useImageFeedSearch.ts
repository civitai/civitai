import { useRouter } from 'next/router';
import type { ImageFeedSearchSort } from '~/components/Image/Infinite/image-feed-search';
import {
  normalizeFeedQuery,
  parseFeedSearchSort,
} from '~/components/Image/Infinite/image-feed-search';
import { useFeedImageItems, useImageQueryParams } from '~/components/Image/image.utils';
import { withPlaceholderData } from '~/hooks/trpcHelpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

const idleInput: SemanticImageSearchInput = { query: '', browsingLevel: 0, limit: 50 };

/** The feed's search text, when this viewer has feed search; otherwise undefined. */
export function useImageFeedSearchQuery() {
  const features = useFeatureFlags();
  const { query } = useImageQueryParams();
  if (!features.feedSearch) return undefined;
  return normalizeFeedQuery(query.query);
}

/**
 * The feed search's sort (`?searchSort=`) and whether the viewer may pick one. Without
 * `imageSearchNewestSort` it is always Best match, whatever the URL says.
 */
export function useImageFeedSearchSort() {
  const router = useRouter();
  const features = useFeatureFlags();
  const selectable = !!features.imageSearchNewestSort;
  const sort = selectable ? parseFeedSearchSort(router.query.searchSort) : undefined;
  const setSort = (next: ImageFeedSearchSort | undefined) =>
    void router.replace(
      { pathname: router.pathname, query: removeEmpty({ ...router.query, searchSort: next }) },
      undefined,
      { shallow: true, scroll: false }
    );
  return { sort, selectable, setSort };
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
