import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { SortAvailability } from '~/components/Filters/sort-availability';

export function useSortAvailability(): SortAvailability {
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  const features = useFeatureFlags();
  const isModerator = useCurrentUser()?.isModerator ?? false;

  return { isModerator, canViewNsfw: features.canViewNsfw, showNsfw };
}
