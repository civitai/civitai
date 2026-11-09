import type { PlacedSticker, StickerPlacementBundle } from '~/components/Sticker/placement.util';
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
