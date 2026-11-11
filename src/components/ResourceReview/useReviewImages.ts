import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { trpc } from '~/utils/trpc';

/**
 * The images of one review, the same set its `imageCount` counts, with the viewer's hidden
 * preferences applied.
 */
export function useReviewImages(
  { reviewId, limit }: { reviewId: number; limit: number },
  { enabled = true }: { enabled?: boolean } = {}
) {
  const browsingLevel = useBrowsingLevelDebounced();
  const { settings } = useBrowsingSettingsAddons();
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

  return { images: items, isLoading: isLoading || loadingPreferences, ...rest };
}
