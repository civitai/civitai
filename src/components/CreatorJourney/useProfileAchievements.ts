import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

// Its own module so the profile nav, on every profile tab, does not pull in the badge components.
/** `spotlight` is the share token a link named; with it, a secret card the link names is keyed by it. */
export function useProfileAchievements(userId: number | undefined, spotlight?: string | null) {
  const features = useFeatureFlags();
  const enabled = !!features.creatorJourney && !!userId;
  const { data, isLoading } = trpc.creatorJourney.getProfileAchievements.useQuery(
    { userId: userId ?? 0, ...(spotlight ? { spotlight } : {}) },
    { enabled }
  );
  const count = (data?.tiers.length ?? 0) + (data?.achievements.length ?? 0);
  return {
    data: enabled ? data : undefined,
    count: enabled ? count : 0,
    isLoading: enabled && isLoading,
  };
}
