import { createContext, useContext, useMemo } from 'react';
import type { RemixGalleryCardSummary } from '~/server/services/remix-gallery.service';
import { chunkStickerIds } from '~/components/Sticker/sticker.util';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
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
  // 🔴 The viewer's level has to travel with the request, exactly as it does on
  // `getRemixGallery`. Omitting it is not a narrower request, it is the widest
  // one: `applyDomainFeature` only rewrites the input when it has a cap to
  // apply, and a signed-in viewer on a mature-allowed domain has none — so zod
  // filled in `allBrowsingLevelsFlag` and the thumbnails, which render as bare
  // `EdgeMedia` with no ImageGuard, came back at every level the viewer had
  // turned off.
  //
  // ⚠️ The PAGE level, while `RemixGalleryCard` reads the VIEWER's. They agree
  // wherever no page sets an override, which is every ordinary feed. Where one
  // does — the site root, the home blocks, a collection — this count is scoped
  // to the page and the gallery it opens is scoped to the viewer, so the two can
  // disagree. Deliberate for now rather than overlooked: this is a count on a
  // card inside a page-scoped feed, and widening it would show a number for
  // content the page narrowed on purpose. Raised with Justin 2026-08-30; if he
  // decides the count should follow the viewer instead, the change is this one
  // line and the reasoning above is what has to be re-argued.
  const browsingLevel = useBrowsingLevelDebounced();

  // The sticker batch's chunker, not a third copy of it. Its own tests pin the
  // property both providers depend on and neither spells out in code: chunking
  // in ARRIVAL order keeps an earlier chunk's key stable as a feed appends lower
  // ids, where sorting would reshuffle every boundary and refetch the surface.
  const chunks = useMemo(
    () => (enabled ? chunkStickerIds(imageIds, SUMMARY_FETCH_CHUNK) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageIds.join(','), enabled]
  );

  const queries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.placement.getRemixGalleryCardSummaries(
        { imageIds: chunk, browsingLevel },
        { staleTime: 60_000 }
      )
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
