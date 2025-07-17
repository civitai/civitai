import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isRegionBlocked } from '~/server/utils/region-blocking';

export function useIsRegionBlocked() {
  const currentUser = useCurrentUser();

  const isBlocked = useMemo(() => {
    // Check the user's region using the currentUser region info
    const regionInfo = currentUser?.region;
    if (regionInfo) {
      return isRegionBlocked(
        regionInfo.countryCode === 'US' ? regionInfo.fullLocationCode : regionInfo.countryCode
      );
    }

    // If no region info available, assume not blocked
    return false;
  }, [currentUser?.region]);

  return { isBlocked };
}
