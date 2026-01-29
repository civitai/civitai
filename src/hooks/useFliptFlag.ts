import type { FLIPT_FEATURE_FLAGS } from '~/server/flipt/client';
import { trpc } from '~/utils/trpc';

/**
 * Hook to check if a Flipt feature flag is enabled for the current user.
 * Uses infinite cache to avoid repeated requests per flag.
 *
 * @example
 * ```tsx
 * const isEnabled = useFliptFlag(FLIPT_FEATURE_FLAGS.LIVE_METRICS);
 * if (isEnabled) {
 *   // Feature is enabled for this user
 * }
 * ```
 */
export function useFliptFlag(flag: FLIPT_FEATURE_FLAGS): boolean {
  const { data: enabled = false } = trpc.system.getFliptFlag.useQuery(
    { flag },
    {
      staleTime: Infinity,
      cacheTime: Infinity,
      retry: false,
    }
  );
  return enabled;
}
