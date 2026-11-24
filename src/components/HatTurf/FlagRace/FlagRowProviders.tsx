import { useMemo } from 'react';
import { FlagRaceContext, type FlagRow } from '~/components/HatTurf/FlagRace/FlagRaceContext';
import { TurfSummaryProvider } from '~/components/HatTurf/TurfSummaryProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * Today's flags and their live counts for an event's Flag Race, and with `past`, past days' results;
 * null while loading or off.
 */
export function useFlagRow(
  event: string | undefined,
  { past }: { past?: boolean } = {}
): FlagRow | null {
  const { data: summary } = trpc.hatTurf.getFlags.useQuery(
    { event: event ?? '' },
    {
      enabled: !!event,
      refetchInterval: 30_000,
      staleTime: 15_000,
      // Unbatched, so the edge caches it: every viewer gets the same answer.
      trpc: { context: { skipBatch: true } },
    }
  );
  const { data: pastFlags } = trpc.hatTurf.getPastFlags.useQuery(
    { event: event ?? '' },
    { enabled: !!event && !!past, staleTime: 5 * 60_000, trpc: { context: { skipBatch: true } } }
  );
  return useMemo(
    () => (event && summary ? { event, summary, past: pastFlags } : null),
    [event, summary, pastFlags]
  );
}

/** The event whose Flag Race this Collection holds (its flags collection), if any. */
export function useCollectionFlagRace(collectionId: number) {
  const features = useFeatureFlags();
  const { data } = trpc.hatTurf.getFlagRaceForCollection.useQuery(
    { collectionId },
    { enabled: !!features.flagRace, staleTime: 5 * 60_000, trpc: { context: { skipBatch: true } } }
  );
  return data ?? undefined;
}

/** Around the flags only: their flags, and the viewer's Hat Turf team and stock for adding hats. */
export function FlagRowProviders({
  row,
  children,
}: {
  row: FlagRow | null;
  children: React.ReactNode;
}) {
  if (!row) return <>{children}</>;
  return (
    <FlagRaceContext.Provider value={row}>
      <TurfSummaryProvider imageIds={[]} gate={{ event: row.event }}>
        {children}
      </TurfSummaryProvider>
    </FlagRaceContext.Provider>
  );
}
