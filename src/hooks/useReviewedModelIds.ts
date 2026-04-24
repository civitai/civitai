import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

const EMPTY_SET: ReadonlySet<number> = new Set();
const setCache = new WeakMap<readonly number[], ReadonlySet<number>>();

/**
 * Returns the current user's reviewed-model ids as a Set for O(1) `has()` lookup.
 *
 * A single Set instance is shared across all consumers that see the same
 * underlying array reference from the React Query cache. For feeds rendering
 * many model cards, this avoids both the per-card Set allocation and the
 * per-card O(N) `includes` scan.
 */
export function useReviewedModelIds(): ReadonlySet<number> {
  const currentUser = useCurrentUser();
  const { data } = trpc.user.getEngagedModels.useQuery(undefined, {
    enabled: !!currentUser,
    cacheTime: Infinity,
    staleTime: Infinity,
  });
  const arr = data?.Recommended;
  return useMemo(() => {
    if (!arr) return EMPTY_SET;
    const cached = setCache.get(arr);
    if (cached) return cached;
    const set = new Set(arr);
    setCache.set(arr, set);
    return set;
  }, [arr]);
}
