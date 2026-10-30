import { useMemo } from 'react';
import { useQueryUserCosmetics } from '~/components/Cosmetics/cosmetics.util';

/** Services count only when the viewer can see them: an offering the flag hides can't fill a shop. */
export const isStorefrontEmpty = ({
  cosmeticCount,
  activeServiceCount,
  servicesEnabled,
}: {
  cosmeticCount: number;
  activeServiceCount: number;
  servicesEnabled: boolean;
}) => cosmeticCount === 0 && (!servicesEnabled || activeServiceCount === 0);

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
