import { useMemo } from 'react';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { normalizeFeedQuery } from '~/components/Image/Infinite/image-feed-search';
import { useImageQueryParams } from '~/components/Image/image.utils';
import { withPlaceholderData } from '~/hooks/trpcHelpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { SemanticImageSearchInput } from '~/server/schema/semantic-image-search.schema';
import { trpc } from '~/utils/trpc';

const idleInput: SemanticImageSearchInput = { query: '', browsingLevel: 0, limit: 50 };

/** The feed's search text, when this viewer has feed search; otherwise undefined. */
export function useImageFeedSearchQuery() {
  const features = useFeatureFlags();
  const { query } = useImageQueryParams();
  if (!features.feedSearch || !features.imageSearch) return undefined;
  return normalizeFeedQuery(query.query);
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

  const flatData = useMemo(() => {
    const seen = new Set<number>();
    return (data?.pages.flatMap((page) => page.items) ?? []).filter(
      (item) => !seen.has(item.id) && !!seen.add(item.id)
    );
  }, [data]);
  // The server already leaves out what the viewer hides; this keeps a just-hidden image off the page.
  const { items } = useApplyHiddenPreferences({
    type: 'images',
    data: flatData,
    isRefetching: rest.isRefetching,
  });

  return { ...rest, images: items, correctedQuery: data?.pages[0]?.correctedQuery };
}
