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
  return data
    ? {
        available: data.available,
        optedIn: data.optedIn,
        cap: data.cap,
        // The wire may hand back a string; the countdown needs a Date.
        nextAt: data.nextAt ? new Date(data.nextAt) : null,
      }
    : undefined;
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

/** Names and art of the viewer's event hats, by cosmetic id. Load it only where it is shown. */
export function useHatLooks(enabled = true) {
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const { data } = trpc.event.getMyHats.useQuery(
    { event: feed?.event ?? '' },
    { enabled: enabled && !!feed && !!user, staleTime: 5 * 60_000 }
  );
  // Hat names end in their team ("Party Cap - Blue"); every hat here is the viewer's team.
  const suffix = feed?.team ? ` - ${feed.team}`.toLowerCase() : null;
  return (cosmeticId: number | undefined) => {
    const hat = data?.find((h) => h.cosmeticId === cosmeticId);
    if (!hat) return undefined;
    const name =
      suffix && hat.name.toLowerCase().endsWith(suffix)
        ? hat.name.slice(0, -suffix.length)
        : hat.name;
    return { ...hat, name };
  };
}
