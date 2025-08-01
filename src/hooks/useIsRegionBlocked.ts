import { useMemo } from 'react';
import { useAppContext } from '~/providers/AppProvider';
import { isRegionBlocked, isRegionPendingBlock } from '~/server/utils/region-blocking';

export function useIsRegionBlocked() {
  const { region } = useAppContext();

  const regionStatus = useMemo(() => {
    // Check the user's region using the currentUser region info
    const regionInfo = region;
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
  }, [region]);

  return regionStatus;
}
