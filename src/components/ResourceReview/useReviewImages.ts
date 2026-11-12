import { useMemo } from 'react';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { trpc } from '~/utils/trpc';

/**
 * The images of one review, the same set its `imageCount` counts. `images` has the viewer's hidden
 * preferences applied; `flatData` is what the server returned, before them.
 */
export function useReviewImages(
  { reviewId, limit }: { reviewId: number; limit: number },
  { enabled = true }: { enabled?: boolean } = {}
) {
  // The level the addon filters were resolved at, so one request never pairs mismatched values.
  const { settings, browsingLevel } = useBrowsingSettingsAddons();
  const { data, isLoading, ...rest } = trpc.resourceReview.getImages.useQuery(
    {
      reviewId,
      limit,
      browsingLevel,
      excludedTagIds: settings.excludedTagIds ?? [],
      disablePoi: settings.disablePoi,
      disableMinor: settings.disableMinor,
    },
    { enabled, retry: 0 }
  );
  const { items, loadingPreferences } = useApplyHiddenPreferences({
    type: 'images',
    data: data?.items,
    isRefetching: rest.isRefetching,
  });

  const flatData = useMemo(() => data?.items ?? [], [data]);

  return { images: items, flatData, isLoading: isLoading || loadingPreferences, ...rest };
}
