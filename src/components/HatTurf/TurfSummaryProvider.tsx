import { createContext, useContext, useMemo } from 'react';
import { useHatTurfFeed } from '~/components/HatTurf/useHatTurfFeed';
import type { TurfSummary } from '~/components/HatTurf/hat-turf.utils';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

/** Matches the `imageIds` cap on `turfSummariesSchema`. */
const SUMMARY_CHUNK = 100;

export type TurfSummaries = {
  event: string;
  /** The viewer's team, or null (signed out, or not in the event). */
  team: string | null;
  images: Record<number, TurfSummary>;
};

export const TurfSummaryContext = createContext<TurfSummaries | null>(null);

/**
 * Hat Turf standings for every image on a surface, fetched once for the ids on it: a feed pays one
 * request per 100 cards, never one per card (tRPC request batching is off by default, so a per-card
 * query is a per-card HTTP request). Chunked in arrival order, not sorted, for the reason
 * `StickerPlacementBatchProvider` gives: a feed appends older ids, and sorting would refetch every
 * earlier chunk on each page.
 *
 * Renders its children bare, and asks nothing, when Hat Turf is not on for this viewer.
 */
export function TurfSummaryProvider({
  imageIds,
  children,
}: {
  imageIds: number[];
  children: React.ReactNode;
}) {
  const gate = useHatTurfFeed();
  const event = gate?.event;

  const chunks = useMemo(
    () => (event ? chunkIds(imageIds, SUMMARY_CHUNK) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageIds.join(','), event]
  );

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.hatTurf.getSummaries({ event: event ?? '', imageIds: chunk }, { staleTime: 30_000 })
    )
  );
  // Change stamps rather than the query array, which is new on every render.
  const stamps = queries.map((query) => query.dataUpdatedAt).join(',');

  const value = useMemo<TurfSummaries | null>(() => {
    if (!event) return null;
    const images: Record<number, TurfSummary> = {};
    let team: string | null = null;
    for (const query of queries) {
      if (!query.data) continue;
      team = query.data.team ?? team;
      Object.assign(images, query.data.images);
    }
    return { event, team, images };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, stamps]);

  return <TurfSummaryContext.Provider value={value}>{children}</TurfSummaryContext.Provider>;
}

/** The feed context: the event and the viewer's team. Null when Hat Turf is off here. */
export const useTurfFeed = () => useContext(TurfSummaryContext);

/** One image's standings, or undefined: no hats on it yet, not loaded, or Hat Turf is off. */
export function useTurfSummary(imageId: number): TurfSummary | undefined {
  return useContext(TurfSummaryContext)?.images[imageId];
}
