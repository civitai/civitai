import type { inferRouterOutputs } from '@trpc/server';
import type { PlacedSticker, StickerPlacementBundle } from '~/components/Sticker/placement.util';
import type { AppRouter } from '~/server/routers';
import type { RemixGalleryCardSummary } from '~/server/services/remix-gallery.service';

/**
 * Ids per card-summary request, for the sticker batch, the remix-gallery batch and the folded
 * read alike. One constant, because the sticker provider reads the folded read's answers by CHUNK
 * INDEX: a different size in either would line a chunk's answer up against other cards' ids.
 * Matches the `imageIds` cap on `getStickerPlacementsSchema`, `getRemixGalleryCardSummariesSchema`
 * and `getImageCardSummariesSchema`.
 */
export const CARD_SUMMARY_FETCH_CHUNK = 100;

export type CardStickerMode = 'placements' | 'counts';

/** What `placement.getImageCardSummaries` returns, inferred from the router. */
type ServerImageCardSummaries = inferRouterOutputs<AppRouter>['placement']['getImageCardSummaries'];

/**
 * That answer as the client reads it from the cache: the server's own type, with the sticker
 * listing widened to `PlacedSticker` (whose `placedAt` may be a string by the time a cache entry
 * is read back — see there). Everything else, `remix` and `errors` included, is the router's.
 */
export type ImageCardSummaries = Omit<ServerImageCardSummaries, 'stickers'> & {
  stickers?: { placements?: PlacedSticker[]; counts: Record<number, number> };
};

type Assert<T extends true> = T;
/**
 * The router's answer must still fit the client's view of it, so a change to the procedure's
 * sticker shape fails typecheck here instead of reading `undefined` at runtime.
 */
export type CardSummariesServerFitsClient = Assert<
  ServerImageCardSummaries extends ImageCardSummaries ? true : false
>;

/** One chunk's answer, in the shape the batch providers read off a query. */
export type CardSummaryChunk<T> = {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  dataUpdatedAt: number;
  /**
   * This half failed inside a folded answer. The provider then makes this half's OWN call for the
   * chunk, so the half retries and reports its error exactly as it did before the fold.
   */
  failed?: boolean;
};

/** A feed surface's folded answers, split per half and aligned to its id chunks. */
export type FoldedCardBatches = {
  combined: CardSummaryChunk<StickerPlacementBundle>[];
  countsOnly: CardSummaryChunk<Record<number, number>>[];
  remix: CardSummaryChunk<Record<number, RemixGalleryCardSummary>>[];
};
