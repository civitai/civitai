import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isRegionBlocked, isRegionPendingBlock } from '~/server/utils/region-blocking';

export function useIsRegionBlocked() {
  const currentUser = useCurrentUser();

  const regionStatus = useMemo(() => {
    // Check the user's region using the currentUser region info
    const regionInfo = currentUser?.region;
    if (regionInfo) {
      return {
        isBlocked: isRegionBlocked(regionInfo),
        isPendingBlock: isRegionPendingBlock(regionInfo),
      };
    }

    // If no region info available, assume not blocked
    return {
      isBlocked: false,
      isPendingBlock: false,
    };
  }, [currentUser?.region]);

  return regionStatus;
}
