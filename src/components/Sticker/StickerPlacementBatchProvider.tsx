import { createContext, useContext, useMemo } from 'react';
import { CARD_SUMMARY_FETCH_CHUNK } from '~/components/Sticker/card-summaries.util';
import type { CardSummaryChunk, FoldedCardBatches } from '~/components/Sticker/card-summaries.util';
import type { StickerTreatmentKey } from '~/components/Sticker/treatments/sticker-treatments';
import { useStickerTreatment } from '~/components/Sticker/treatments/useStickerTreatment';
import type { PlacedSticker, StickerPlacementBundle } from '~/components/Sticker/placement.util';
import { groupPlacementsByImage, resolveStickerCounts } from '~/components/Sticker/placement.util';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { stickersRevealed, useStickerRevealStore } from '~/store/sticker-reveal.store';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

type StickerPlacementBatch = {
  counts: Record<number, number>;
  byImage: Map<number, PlacedSticker[]>;
  sticker: Map<number, ResolvedSticker>;
  treatment: StickerTreatmentKey;
};

const StickerPlacementBatchContext = createContext<StickerPlacementBatch | null>(null);

/**
 * Whether a surface fetches sticker data at all, and whether it wants placements
 * or counts alone. Shared with the folded card read so both decide alike.
 */
export function useStickerBatchWants(alwaysFetch?: boolean) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const revealed = useStickerRevealStore(stickersRevealed);

  const enabled = !!features.stickers && !!features.stickerPlacement;
  // Same rule as the detail view: a signed-in viewer always fetches, because a
  // pending placement is one they either paid for or are being asked to answer,
  // and neither is discoverable from the count (which is approved-only).
  const wantPlacements = enabled && (revealed || !!currentUser || !!alwaysFetch);
  return { enabled, wantPlacements };
}

/**
 * Placement data for a whole surface, fetched once for the ids on it.
 *
 * The alternative — placement riding along in the feed payload — would mean
 * joining into `getInfiniteImages`, which is the hottest path in the product and
 * edge-cached for anonymous users. It is not needed: the count query already
 * takes an array, so a feed pays one lookup per 100 cards instead of one per
 * card. tRPC request batching is behind a flag that is off by default, so a
 * per-card query really is a per-card HTTP request.
 *
 * **Chunked in arrival order, not sorted.** Sorting looks tidier and is wrong
 * here: a feed appends *older* (lower) ids as you scroll, so a sorted list
 * reshuffles every chunk boundary on every page and refetches the entire feed's
 * worth of placements each time. Arrival order means an earlier chunk's key
 * never changes once it is full.
 */
export function StickerPlacementBatchProvider({
  imageIds,
  children,
  alwaysFetch,
  folded,
}: {
  imageIds: number[];
  children: React.ReactNode;
  /**
   * Fetch even when the viewer has stickers hidden and is logged out.
   *
   * 🔴 THE FETCH GATE IS SEPARATE FROM THE DRAW GATE, and a host that overrides
   * only the second one gets nothing. A surface whose subject IS the stickers
   * has to say so here too, or an anonymous visitor renders a page of images
   * with no stickers on them and no error anywhere.
   */
  alwaysFetch?: boolean;
  /**
   * This surface's answers from the folded card read, which replace both calls below — except
   * for a chunk whose sticker half failed there, which makes its own call as before.
   */
  folded?: Pick<FoldedCardBatches, 'combined' | 'countsOnly'>;
}) {
  const { enabled, wantPlacements } = useStickerBatchWants(alwaysFetch);

  const chunks = useMemo(
    () => (enabled ? chunkIds(imageIds, CARD_SUMMARY_FETCH_CHUNK) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageIds.join(','), enabled]
  );

  // ONE call per chunk wherever placements are wanted: the combined call carries
  // the counts too. The count-only call is for the one case that wants nothing
  // else — an anonymous viewer with stickers hidden — and stays the
  // edge-cacheable request it always was. Before this, a signed-in viewer paid
  // for both calls on every chunk of every surface.
  //
  // With `folded`, a chunk makes its own call only where the folded answer's
  // sticker half failed: that call then retries and errors exactly as it did
  // before the fold. The folded chunks line up with these by index because both
  // chunk the same ids in the same order by `CARD_SUMMARY_FETCH_CHUNK`.
  const ownCountQueries = trpc.useQueries((t) =>
    chunks.map((chunk, index) =>
      t.placement.getStickerPlacementCounts(
        { imageIds: chunk },
        {
          staleTime: 60_000,
          enabled: (!folded || !!folded.countsOnly[index]?.failed) && !wantPlacements,
        }
      )
    )
  );

  const ownCombinedQueries = trpc.useQueries((t) =>
    chunks.map((chunk, index) =>
      t.placement.getStickerPlacementsAndCounts(
        { imageIds: chunk },
        {
          staleTime: 60_000,
          enabled: (!folded || !!folded.combined[index]?.failed) && wantPlacements,
        }
      )
    )
  );

  const countQueries: CardSummaryChunk<Record<number, number>>[] = folded
    ? chunks.map((_, index) => {
        const answer = folded.countsOnly[index];
        return !answer || answer.failed ? ownCountQueries[index] : answer;
      })
    : ownCountQueries;
  const combinedQueries: CardSummaryChunk<unknown>[] = folded
    ? chunks.map((_, index) => {
        const answer = folded.combined[index];
        return !answer || answer.failed ? ownCombinedQueries[index] : answer;
      })
    : ownCombinedQueries;

  // Change stamps rather than the query arrays, which are new on every render.
  const countStamps = countQueries.map((query) => query.dataUpdatedAt).join(',');
  const combinedStamps = combinedQueries.map((query) => query.dataUpdatedAt).join(',');

  const counts = useMemo(
    () =>
      Object.assign(
        {},
        ...chunks.map(
          (_, index) =>
            resolveStickerCounts({
              wantPlacements,
              combined: {
                data: (combinedQueries[index]?.data as StickerPlacementBundle | undefined)?.counts,
                isLoading: !!combinedQueries[index]?.isLoading,
                isError: !!combinedQueries[index]?.isError,
              },
              countsOnly: {
                data: countQueries[index]?.data,
                isLoading: !!countQueries[index]?.isLoading,
                isError: !!countQueries[index]?.isError,
              },
            }).counts
        )
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wantPlacements, countStamps, combinedStamps]
  ) as Record<number, number>;

  const byImage = useMemo(
    () =>
      groupPlacementsByImage(
        combinedQueries.flatMap(
          (query) => (query.data as StickerPlacementBundle | undefined)?.placements ?? []
        )
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [combinedStamps]
  );

  // Resolved here rather than per card. `useStickerCosmetics` chunks at 100 ids,
  // so a whole surface's artwork is a handful of requests — where a card
  // resolving its own is a request per distinct sticker set, which is a request
  // per card as soon as stickers vary. Batching the placements and then paying
  // per card for the artwork needed to draw them would have left the headline
  // property of this provider true only for the cheap half.
  //
  // Per **surface**, not per page: a home page mounts several `ImagesProvider`s
  // (feed block, collection blocks, profile sections) and each gets its own
  // provider and its own query, with no sharing even where their sticker sets
  // overlap. That is the per-surface design rather than a defect, and it is
  // still far cheaper than the per-card cost it replaced.
  //
  // Deduped here as well as inside the hook: the hook's memo key is the joined
  // id string, and a surface with 500 placements of 20 stickers would otherwise
  // build and join a 500-element array on every render of this provider.
  const cosmeticIds = useMemo(() => {
    const ids = new Set<number>();
    for (const placements of byImage.values())
      for (const placement of placements) ids.add(placement.data.cosmeticId);
    return [...ids];
  }, [byImage]);

  const { sticker } = useStickerCosmetics(cosmeticIds);

  // Resolved once for the surface, like everything else here. Per card it would
  // be N subscriptions to the user's settings, and — because it reads
  // `useRouter` — N context consumers that re-render THROUGH `React.memo` on
  // every routed dialog, defeating the memo the feed has for exactly that.
  const treatment = useStickerTreatment();

  const value = useMemo(
    () => ({ counts, byImage, sticker, treatment }),
    [counts, byImage, sticker, treatment]
  );

  if (!enabled) return <>{children}</>;

  return (
    <StickerPlacementBatchContext.Provider value={value}>
      {children}
    </StickerPlacementBatchContext.Provider>
  );
}

/**
 * What one card gets, or `null` on a surface with no provider.
 *
 * Deliberately no per-card fallback query: a card that quietly fetched for
 * itself would reintroduce exactly the per-card request this exists to avoid,
 * and it would do it invisibly, on whichever surface forgot the provider. A
 * surface without one shows no stickers, which is a thing you can see.
 */
export function useStickerPlacementBatch(imageId: number) {
  const batch = useContext(StickerPlacementBatchContext);

  return useMemo(() => {
    if (!batch) return null;
    const placements = batch.byImage.get(imageId) ?? [];
    return {
      count: batch.counts[imageId] ?? 0,
      placements,
      pending: placements.filter((placement) => placement.isPending),
      sticker: batch.sticker,
      treatment: batch.treatment,
    };
  }, [batch, imageId]);
}
