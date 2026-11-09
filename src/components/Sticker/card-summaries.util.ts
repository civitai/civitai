import { useViewerBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import type { PlacedSticker, StickerPlacementBundle } from '~/components/Sticker/placement.util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { RemixGalleryCardSummary } from '~/server/services/remix-gallery.service';

export type CardStickerMode = 'placements' | 'counts';

/** What `placement.getImageCardSummaries` returns. */
export type ImageCardSummaries = {
  stickers?: { placements?: PlacedSticker[]; counts: Record<number, number> };
  remix?: Record<number, RemixGalleryCardSummary>;
};

/** One chunk's answer, in the shape the batch providers read off a query. */
export type CardSummaryChunk<T> = {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  dataUpdatedAt: number;
};

/** A feed surface's folded answers, split per half and aligned to its id chunks. */
export type FoldedCardBatches = {
  combined: CardSummaryChunk<StickerPlacementBundle>[];
  countsOnly: CardSummaryChunk<Record<number, number>>[];
  remix: CardSummaryChunk<Record<number, RemixGalleryCardSummary>>[];
};

/**
 * The one input builder for `getImageCardSummaries`.
 *
 * 🔴 Every caller on a page builds its input here, because sharing a request
 * depends on the inputs being equal: on the detail view the sticker bar, the
 * sticker overlay and the remix card each ask for the same image, and one
 * request answers all three only while their inputs match.
 */
export function cardSummaryInput({
  imageIds,
  stickers,
  remix,
  browsingLevel,
}: {
  imageIds: number[];
  stickers?: CardStickerMode;
  remix: boolean;
  browsingLevel: number;
}) {
  return {
    imageIds,
    ...(stickers ? { stickers } : {}),
    ...(remix ? { remix: true, browsingLevel } : {}),
  };
}

/**
 * Whether this viewer's detail-view reads go through the folded call, and the
 * remix half that call carries there.
 *
 * The remix half is the remix card's own condition for asking for its summary,
 * so the sticker reads on the same page build the input the card builds.
 */
export function useDetailCardSummaryFold() {
  const features = useFeatureFlags();
  const browsingLevel = useViewerBrowsingLevelDebounced();
  return {
    on: !!features.placementCardFold,
    remix: !!features.remixGallery && !!features.storylines,
    browsingLevel,
  };
}

/** Which sticker read the detail view's bar makes, and so which one the remix card shares. */
export function detailStickerMode({
  signedIn,
  revealed,
}: {
  signedIn: boolean;
  revealed: boolean;
}): CardStickerMode {
  return signedIn || revealed ? 'placements' : 'counts';
}
