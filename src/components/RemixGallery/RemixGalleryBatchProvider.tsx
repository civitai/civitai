import { createContext, useContext, useMemo } from 'react';
import type { RemixGalleryCardSummary } from '~/server/services/remix-gallery.service';
import { CARD_SUMMARY_FETCH_CHUNK } from '~/components/Sticker/card-summaries.util';
import type { CardSummaryChunk, FoldedCardBatches } from '~/components/Sticker/card-summaries.util';

import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

const RemixGalleryBatchContext = createContext<Record<number, RemixGalleryCardSummary> | null>(
  null
);

/**
 * Remix-gallery counts and preview thumbnails for a whole surface.
 *
 * A sibling of `StickerPlacementBatchProvider` with its own QUERY, never a
 * merged one. The two read the same table and differ only by `surface`, which
 * makes merging them look obvious — but a sticker count is `status = 'approved'`
 * and nothing else, while a gallery entry has to clear published, scanned,
 * unflagged, within-browsing-level and a minor-host ceiling. One query would weld
 * a strict safety contract onto a read that has none.
 *
 * The REQUEST is a different matter. Behind `placementCardFold`, a feed surface
 * that wants both this and the sticker data asks for them in one
 * `getImageCardSummaries` call per chunk (`useFoldedCardBatches`), passed in here
 * as `folded`: fewer requests per surface, while each half still runs its own
 * procedure's service read with its own arguments. With the flag off, or the
 * sticker half not wanted, this provider makes its own call as it always has —
 * and so does a chunk whose remix half failed in the folded answer, so it
 * retries and errors exactly as it did before the fold.
 *
 * Chunked in arrival order for the same reason the sticker batch is: a feed
 * appends lower ids as it pages, so sorting would reshuffle every chunk boundary
 * and refetch the whole surface each time.
 */
export function RemixGalleryBatchProvider({
  imageIds,
  children,
  folded,
}: {
  imageIds: number[];
  children: React.ReactNode;
  /**
   * This surface's answers from the folded card read, which replace the call below — except for
   * a chunk whose remix half failed there, which makes its own call as before.
   */
  folded?: FoldedCardBatches['remix'];
}) {
  const { enabled, browsingLevel } = useRemixBatchRequest();

  // The sticker batch's chunker, not a third copy of it. Its own tests pin the
  // property both providers depend on and neither spells out in code: chunking
  // in ARRIVAL order keeps an earlier chunk's key stable as a feed appends lower
  // ids, where sorting would reshuffle every boundary and refetch the surface.
  const chunks = useMemo(
    () => (enabled ? chunkIds(imageIds, CARD_SUMMARY_FETCH_CHUNK) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageIds.join(','), enabled]
  );

  // With `folded`, only a chunk whose folded remix half failed makes its own
  // call. Lined up by index: both chunk the same ids in the same order by
  // `CARD_SUMMARY_FETCH_CHUNK`.
  const ownQueries = trpc.useQueries((t) =>
    chunks.map((chunk, index) =>
      t.placement.getRemixGalleryCardSummaries(
        { imageIds: chunk, browsingLevel },
        { staleTime: 60_000, enabled: !folded || !!folded[index]?.failed }
      )
    )
  );
  const queries: CardSummaryChunk<Record<number, RemixGalleryCardSummary>>[] = folded
    ? chunks.map((_, index) => {
        const answer = folded[index];
        return !answer || answer.failed ? ownQueries[index] : answer;
      })
    : ownQueries;

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
 * Whether a surface asks for remix-gallery summaries, and at which level. Shared
 * with the folded card read so both ask alike.
 */
export function useRemixBatchRequest() {
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
  // 🔴 The VIEWER's level, matching `RemixGalleryCard`. This count and the
  // gallery it opens are one concept and were reading two different numbers:
  // wherever a page set an override — the site root, the home blocks, a
  // collection — the count was page-scoped while the gallery was viewer-scoped,
  // which is the count-versus-contents mismatch #4497 fixed on the other side.
  // Justin's call, 2026-08-30.
  //
  // ⚠️ The consequence, since it is the argument against: on a page that
  // deliberately narrows itself, the count and its thumbnails now follow the
  // viewer rather than the page. Domain and policy caps still apply — they ride
  // `forcedBrowsingLevel`, which this hook honours — so what widens is a page's
  // curation choice, never a ceiling.
  const browsingLevel = useViewerBrowsingLevelDebounced();
  return { enabled, browsingLevel };
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
