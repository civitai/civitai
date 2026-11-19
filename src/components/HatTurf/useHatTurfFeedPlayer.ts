import { useHatTurfFeed } from '~/components/HatTurf/useHatTurfFeed';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useShowEventCosmetics } from '~/providers/BrowserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * The viewer plays Hat Turf in the feed: the feed card and the feed sorts are on for them, event
 * cosmetics are on, and they joined. Null for anyone else. The server checks the same
 * (getHatTurfFeedEvent) and ignores the Hat Turf sorts and filters from anyone it refuses.
 */
export function useHatTurfFeedPlayer(): { event: string; teams: string[] } | null {
  const features = useFeatureFlags();
  const feed = useHatTurfFeed();
  const shown = useShowEventCosmetics();
  const user = useCurrentUser();
  const event = shown && features.hatTurfFeedSorts ? feed?.event : undefined;
  // The same query as useHatStock, so they share one cache entry.
  const { data: stock } = trpc.hatTurf.getStock.useQuery(
    { event: event ?? '' },
    { enabled: !!event && !!user, staleTime: 30_000 }
  );
  if (!event || !user || !stock?.optedIn) return null;
  return { event, teams: Object.keys(stock.creditedByTeam) };
}
