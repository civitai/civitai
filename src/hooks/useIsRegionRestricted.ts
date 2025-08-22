import { useMemo } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useAppContext } from '~/providers/AppProvider';
import { isRegionRestricted, isRegionPendingRestriction } from '~/server/utils/region-blocking';

export function useIsRegionRestricted() {
  const currentUser = useCurrentUser();
  const { region } = useAppContext();

  const restrictionStatus = useMemo(() => {
    // If the user is a moderator, they are exempt from region restrictions
    if (currentUser?.isModerator) {
      return { isRestricted: false, isPendingRestriction: false };
    }

    if (region) {
      const isRestricted = isRegionRestricted(region);
      const isPendingRestriction = isRegionPendingRestriction(region);

      return { isRestricted, isPendingRestriction };
    }

    // If no region info available, assume not restricted
    return { isRestricted: false, isPendingRestriction: false };
  }, [currentUser?.isModerator, region]);

  return restrictionStatus;
}
