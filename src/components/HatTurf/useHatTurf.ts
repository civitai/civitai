import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { trpc } from '~/utils/trpc';

/** Undefined while signed out or Hat Turf is off. */
export function useHatStock() {
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const { data } = trpc.hatTurf.getStock.useQuery(
    { event: feed?.event ?? '' },
    { enabled: !!feed && !!user, staleTime: 30_000 }
  );
  return data ? { available: data.available, optedIn: data.optedIn } : undefined;
}

/** The hat a press places: the one picked in the gear menu, else the most recently used. */
export function useChosenHat() {
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const picked = useHatTurfStore((state) => state.cosmeticId);
  const { data: hats } = trpc.hatTurf.getMyStickerHats.useQuery(
    { event: feed?.event ?? '' },
    { enabled: !!feed && !!user, staleTime: 5 * 60_000 }
  );
  const cosmeticId =
    picked && hats?.some((hat) => hat.cosmeticId === picked) ? picked : hats?.[0]?.cosmeticId;
  return { cosmeticId, hats };
}
