import { createContext, useContext, useMemo } from 'react';
import type { PlacedSticker } from '~/components/Sticker/placement.util';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { useStickerCosmetics } from '~/components/Sticker/sticker.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';
import { trpc } from '~/utils/trpc';

/** Matches the `imageIds` cap on `getStickerPlacementsSchema`. */
const PLACEMENT_FETCH_CHUNK = 100;

type StickerPlacementBatch = {
  counts: Record<number, number>;
  byImage: Map<number, PlacedSticker[]>;
  sticker: Map<number, ResolvedSticker>;
};

const StickerPlacementBatchContext = createContext<StickerPlacementBatch | null>(null);

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
}: {
  imageIds: number[];
  children: React.ReactNode;
}) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const revealed = useStickerRevealStore((state) => state.revealed);

  const enabled = !!features.stickers && !!features.stickerPlacement;

  const chunks = useMemo(() => {
    if (!enabled) return [] as number[][];
    const unique = [...new Set(imageIds)];
    const result: number[][] = [];
    for (let i = 0; i < unique.length; i += PLACEMENT_FETCH_CHUNK)
      result.push(unique.slice(i, i + PLACEMENT_FETCH_CHUNK));
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageIds.join(','), enabled]);

  const countQueries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.placement.getStickerPlacementCounts({ imageIds: chunk }, { staleTime: 60_000 })
    )
  );

  // Same rule as the detail view: a signed-in viewer always fetches, because a
  // pending placement is one they either paid for or are being asked to answer,
  // and neither is discoverable from the count (which is approved-only).
  const wantPlacements = enabled && (revealed || !!currentUser);
  const placementQueries = trpc.useQueries((t) =>
    chunks.map((chunk) =>
      t.placement.getStickerPlacements(
        { imageIds: chunk },
        { staleTime: 60_000, enabled: wantPlacements }
      )
    )
  );

  const counts = useMemo(
    () => Object.assign({}, ...countQueries.map((query) => query.data ?? {})),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [countQueries.map((query) => query.dataUpdatedAt).join(',')]
  ) as Record<number, number>;

  const byImage = useMemo(() => {
    const map = new Map<number, PlacedSticker[]>();
    for (const query of placementQueries)
      for (const placement of (query.data as PlacedSticker[] | undefined) ?? []) {
        const list = map.get(placement.imageId) ?? [];
        list.push(placement);
        map.set(placement.imageId, list);
      }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placementQueries.map((query) => query.dataUpdatedAt).join(',')]);

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

  const value = useMemo(() => ({ counts, byImage, sticker }), [counts, byImage, sticker]);

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
    };
  }, [batch, imageId]);
}
