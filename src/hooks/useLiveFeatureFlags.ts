import { DEFAULT_LIVE_FEATURE_FLAGS } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';

export function useLiveFeatureFlags() {
  const { data: liveFeatureFlags, isLoading } = trpc.system.getLiveFeatureFlags.useQuery(
    undefined,
    {
      refetchOnWindowFocus: true,
      trpc: { context: { skipBatch: true } },
    }
  );

  return isLoading ? DEFAULT_LIVE_FEATURE_FLAGS : liveFeatureFlags ?? DEFAULT_LIVE_FEATURE_FLAGS;
}
