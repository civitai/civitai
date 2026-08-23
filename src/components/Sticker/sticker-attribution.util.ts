import { useMemo } from 'react';
import { useHiddenPreferencesData } from '~/hooks/hidden-preferences';
import { trpc } from '~/utils/trpc';

/**
 * One sticker's attribution, with the viewer's own suppression applied.
 *
 * 🔴 THE SUPPRESSION IS THE REASON THIS IS SHARED. A block hides that creator's
 * shop entries already — the shop filters on `getBlockedPairIds` — but the
 * sticker's creator is not the author of whatever the sticker is sitting on, so
 * nothing at the surface level ever sees them. Without this, blocking someone
 * leaves their storefront one hover away from any sticker of theirs, on every
 * surface that draws one. A second surface re-deriving the rule is how one of
 * them ends up without it.
 *
 * Three lists, and only one of them is a block: `hiddenUsers` is "people I hid",
 * while a block is a PAIR — `blockedUsers` one way, `blockedByUsers` the other.
 * The name survives suppression; the route and the creator card do not.
 */
export function useStickerAttribution(cosmeticId: number | null) {
  const { data, isLoading } = trpc.cosmetic.getStickerAttribution.useQuery(
    { ids: cosmeticId == null ? [] : [cosmeticId] },
    { staleTime: 5 * 60_000, enabled: cosmeticId != null }
  );
  const raw = data?.[0];

  const preferences = useHiddenPreferencesData();
  const suppressed = useMemo(
    () =>
      new Set([
        ...preferences.hiddenUsers.map((user) => user.id),
        ...preferences.blockedUsers.map((user) => user.id),
        ...preferences.blockedByUsers.map((user) => user.id),
      ]),
    [preferences.hiddenUsers, preferences.blockedUsers, preferences.blockedByUsers]
  );

  const blocked = !!raw?.creatorId && suppressed.has(raw.creatorId);

  return {
    sticker: raw && blocked ? { ...raw, shopHref: null, creatorId: null } : raw,
    /**
     * Reported rather than left to be re-derived from the nulled fields: a
     * creator whose account is deleted or banned arrives with the same nulls
     * from the server, and those two are not the same case for anything that
     * wants to draw a creator card.
     */
    blocked,
    isLoading,
  };
}
