import { useEffect } from 'react';
import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';
import { useHatTurfStore } from '~/components/HatTurf/hat-turf.store';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

// One timer per due time for the whole page, however many cards read the stock: when the next hat
// is due, the stock is reread once, so every count and timer moves on together. Kept until its last
// reader moves to a new due time: a card mounting after it fired schedules nothing, and a reread
// that brings back the same due time (a client clock ahead of the server) or fails is retried.
/** Read at each retry, so a test can shorten it. */
export const stockRefreshTiming = { retryMs: 30_000 };
type DueRefresh = { users: number; timer: number };
const refreshes = new Map<number, DueRefresh>();
function useRefreshWhenDue(due: number | undefined, refresh: () => void) {
  useEffect(() => {
    if (!due) return;
    let entry = refreshes.get(due);
    if (!entry) {
      const created: DueRefresh = { users: 0, timer: 0 };
      // Each retry waits twice as long, up to 8x: a stock read that keeps failing is not polled
      // at the first retry's rate for as long as the tab stays open.
      let wait = stockRefreshTiming.retryMs;
      const fire = () => {
        refresh();
        created.timer = window.setTimeout(fire, wait);
        wait = Math.min(wait * 2, stockRefreshTiming.retryMs * 8);
      };
      created.timer = window.setTimeout(fire, Math.max(0, due - Date.now()) + 500);
      refreshes.set(due, created);
      entry = created;
    }
    entry.users++;
    const joined = entry;
    return () => {
      if (--joined.users > 0) return;
      window.clearTimeout(joined.timer);
      if (refreshes.get(due) === joined) refreshes.delete(due);
    };
    // The first reader's refresh serves them all; every reader's rereads the same query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [due]);
}

/** Undefined while signed out or Hat Turf is off. */
export function useHatStock() {
  const feed = useTurfFeed();
  const user = useCurrentUser();
  const utils = trpc.useUtils();
  const { data } = trpc.hatTurf.getStock.useQuery(
    { event: feed?.event ?? '' },
    { enabled: !!feed && !!user, staleTime: 30_000 }
  );
  const due = data?.nextAt ? new Date(data.nextAt).getTime() : undefined;
  // Never cancels a reread already in flight.
  useRefreshWhenDue(
    due,
    () => void utils.hatTurf.getStock.invalidate(undefined, undefined, { cancelRefetch: false })
  );
  return data
    ? {
        available: data.available,
        optedIn: data.optedIn,
        left: data.left,
        ownerOff: data.ownerOff,
        cap: data.cap,
        /** How many of the viewer's team's stickers score on an image it leads. */
        creditedPlayers: data.creditedPlayers,
        /** Per team, how many of its stickers score on an image it leads (creditedForTeam). */
        creditedByTeam: data.creditedByTeam,
        /** How long a sticker counts (stickerExpiresAt); null when stickers do not expire. */
        expiry: data.expiry
          ? {
              ttlHours: data.expiry.ttlHours,
              rolloutAt: data.expiry.rolloutAt ? new Date(data.expiry.rolloutAt) : undefined,
            }
          : null,
        // The wire may hand back a string; the countdown needs a Date.
        nextAt: data.nextAt ? new Date(data.nextAt) : null,
        /** Hats per hour, with the team's catch-up applied. */
        perHour: data.perHour,
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

/** Joins or leaves Hat Turf, refreshing the stock and the images it opens or closes. */
export function useJoin(onDone?: () => void) {
  const utils = trpc.useUtils();
  return trpc.hatTurf.setOptIn.useMutation({
    onSuccess: () => {
      onDone?.();
      void utils.hatTurf.getStock.invalidate();
      void utils.hatTurf.getSummaries.invalidate();
    },
    onError: (error) => showErrorNotification({ title: "Couldn't update Hat Turf", error }),
  });
}

/**
 * The event Hat Turf runs for on a surface this signed-in viewer can see, and their stock in it.
 * Both undefined otherwise, and the stock also while turf is off.
 */
export function useTurfGate(enabled = true) {
  const user = useCurrentUser();
  const features = useFeatureFlags();
  const definition = usePlayableEventDecoration(
    'Image',
    enabled && !!user && (!!features.hatTurfImageDetail || !!features.hatTurfFeedCard)
  );
  const event = definition?.event;
  const { data: stock } = trpc.hatTurf.getStock.useQuery(
    { event: event ?? '' },
    { enabled: !!event, staleTime: 30_000 }
  );
  return { event, stock: event && stock?.mode !== 'off' ? stock : undefined };
}
