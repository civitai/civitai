import { createContext, useContext, useMemo } from 'react';
import type { RemixGalleryCardSummary } from '~/server/services/remix-gallery.service';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/** Matches the `imageIds` cap on `getRemixGalleryCardSummariesSchema`. */
const SUMMARY_FETCH_CHUNK = 100;

const RemixGalleryBatchContext = createContext<Record<number, RemixGalleryCardSummary> | null>(
  null
);

/**
 * Remix-gallery counts and preview thumbnails for a whole surface.
 *
 * Deliberately a sibling of `StickerPlacementBatchProvider` rather than folded
 * into it. The two read the same table and differ only by `surface`, which makes
 * merging them look obvious — but a sticker count is `status = 'approved'` and
 * nothing else, while a gallery entry has to clear published, scanned, unflagged,
 * within-browsing-level and a minor-host ceiling. Fusing them would weld a strict
 * safety contract onto a query that has none, to save a request that HTTP/2 and
 * HTTP/3 already multiplex.
 *
 * Chunked in arrival order for the same reason the sticker batch is: a feed
 * appends lower ids as it pages, so sorting would reshuffle every chunk boundary
 * and refetch the whole surface each time.
 */
export function RemixGalleryBatchProvider({
  imageIds,
  children,
}: {
  imageIds: number[];
  children: React.ReactNode;
}) {
  const features = useFeatureFlags();
  const enabled = !!features.remixGallery;

  const chunks = useMemo(() => {
    if (!enabled) return [] as number[][];
    const unique = [...new Set(imageIds)];
    const result: number[][] = [];
    for (let i = 0; i < unique.length; i += SUMMARY_FETCH_CHUNK)
      result.push(unique.slice(i, i + SUMMARY_FETCH_CHUNK));
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageIds.join(','), enabled]);

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.placement.getRemixGalleryCardSummaries({ imageIds: chunk }, { staleTime: 60_000 })
    )
  );

  const summaries = useMemo(
    () => Object.assign({}, ...queries.map((query) => query.data ?? {})),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queries.map((query) => query.dataUpdatedAt).join(',')]
  ) as Record<number, RemixGalleryCardSummary>;

  if (!enabled) return <>{children}</>;

  return (
    <RemixGalleryBatchContext.Provider value={summaries}>
      {children}
    </RemixGalleryBatchContext.Provider>
  );
}

/**
 * What one card gets, or `null` on a surface with no provider.
 *
 * No per-card fallback query, for the reason the sticker batch gives: a card
 * that quietly fetched for itself would reintroduce the per-card request this
 * exists to avoid, and would do it invisibly on whichever surface forgot the
 * provider. A surface without one shows no frames, which is visible.
 */
export function useRemixGalleryBatch(imageId: number) {
  const summaries = useContext(RemixGalleryBatchContext);
  return useMemo(() => {
    if (!summaries) return null;
    return summaries[imageId] ?? { count: 0, entries: [] };
  }, [summaries, imageId]);
}
