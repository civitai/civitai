import { useMemo } from 'react';
import { useQueryUserCosmetics } from '~/components/Cosmetics/cosmetics.util';

export function useOwnedCosmeticIds() {
  const { data: userCosmetics } = useQueryUserCosmetics();
  return useMemo(
    () =>
      new Set(
        Object.values(userCosmetics ?? {})
          .flat()
          .map((c) => c.id)
      ),
    [userCosmetics]
  );
}
