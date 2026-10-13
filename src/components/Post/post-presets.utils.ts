import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

export function usePostPresets() {
  const enabled = !!useFeatureFlags().postPresets;
  return trpc.postPreset.getAll.useQuery(undefined, {
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}
