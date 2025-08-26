import { useMemo } from 'react';
import { useAppContext } from '~/providers/AppProvider';
import { isRegionBlocked, isRegionPendingBlock } from '~/server/utils/region-blocking';

export function useIsRegionBlocked() {
  const { region } = useAppContext();

  const regionStatus = useMemo(() => {
    if (region) {
      return {
        isBlocked: isRegionBlocked(region),
        isPendingBlock: isRegionPendingBlock(region),
      };
    }

    // If no region info available, assume not blocked or restricted
    return { isBlocked: false, isPendingBlock: false };
  }, [region]);

  return regionStatus;
}
