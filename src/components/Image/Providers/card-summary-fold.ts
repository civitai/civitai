import { useMemo } from 'react';
import { useRemixBatchRequest } from '~/components/RemixGallery/RemixGalleryBatchProvider';
import { useStickerBatchWants } from '~/components/Sticker/StickerPlacementBatchProvider';
import { CARD_SUMMARY_FETCH_CHUNK } from '~/components/Sticker/card-summaries.util';
import type {
  CardStickerMode,
  CardSummaryChunk,
  FoldedCardBatches,
  ImageCardSummaries,
} from '~/components/Sticker/card-summaries.util';
import type { StickerPlacementBundle } from '~/components/Sticker/placement.util';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { chunkIds } from '~/utils/array-helpers';
import { trpc } from '~/utils/trpc';

/** The parts of a folded query a chunk is built from. */
type FoldQuery = {
  data?: ImageCardSummaries;
  isLoading: boolean;
  isError: boolean;
  dataUpdatedAt: number;
};

/**
 * One half of one chunk. A half the server answered under `errors` is `failed`: the provider then
 * makes that half's own call for the chunk, which retries and errors as it did before the fold.
 */
const chunkOf = <T>(
  query: FoldQuery | undefined,
  data: T | undefined,
  failed = false
): CardSummaryChunk<T> => ({
  data: failed ? undefined : data,
  isLoading: !failed && !!query?.isLoading,
  isError: failed || !!query?.isError,
  dataUpdatedAt: query?.dataUpdatedAt ?? 0,
  failed,
});

/**
 * A feed surface's sticker and remix-gallery reads as ONE call per 100 cards,
 * for viewers on `placementCardFold`, and only where the surface wants BOTH
 * halves. `undefined` otherwise — flag off, or either half not wanted — which
 * leaves both batch providers making their own calls exactly as before.
 *
 * One query set per sticker mode, like the sticker provider's own pair, so the
 * counts answer a viewer already has stays on screen while revealing switches
 * them to the placements call — a disabled query keeps its data.
 */
export function useFoldedCardBatches(
  imageIds: number[],
  alwaysFetch?: boolean
): FoldedCardBatches | undefined {
  const features = useFeatureFlags();
  const sticker = useStickerBatchWants(alwaysFetch);
  const remix = useRemixBatchRequest();
  const active = !!features.placementCardFold && sticker.enabled && remix.enabled;

  const chunks = useMemo(
    () => (active ? chunkIds(imageIds, CARD_SUMMARY_FETCH_CHUNK) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageIds.join(','), active]
  );

  const mode: CardStickerMode = sticker.wantPlacements ? 'placements' : 'counts';
  const modes: CardStickerMode[] = ['placements', 'counts'];
  const queries: FoldQuery[] = trpc.useQueries((t) =>
    modes.flatMap((stickers) =>
      chunks.map((chunk) =>
        t.placement.getImageCardSummaries(
          { imageIds: chunk, stickers, remix: true, browsingLevel: remix.browsingLevel },
          { staleTime: 60_000, enabled: stickers === mode }
        )
      )
    )
  );
  const placementsQueries = queries.slice(0, chunks.length);
  const countsQueries = queries.slice(chunks.length);

  if (!active) return undefined;

  const [current, other] =
    mode === 'placements' ? [placementsQueries, countsQueries] : [countsQueries, placementsQueries];

  return {
    combined: chunks.map((_, index) =>
      chunkOf(
        placementsQueries[index],
        placementsQueries[index]?.data?.stickers as StickerPlacementBundle | undefined,
        !!placementsQueries[index]?.data?.errors?.stickers
      )
    ),
    countsOnly: chunks.map((_, index) =>
      chunkOf(
        countsQueries[index],
        countsQueries[index]?.data?.stickers?.counts,
        !!countsQueries[index]?.data?.errors?.stickers
      )
    ),
    // The current mode's answer; the other mode's cached one for the same chunk
    // stands in until it lands, so a reveal does not blank the remix frames. Failed
    // only when neither has remix data and the current one answered an error.
    remix: chunks.map((_, index) => {
      const answered = [current[index], other[index]].find((query) => query?.data?.remix);
      return chunkOf(
        answered ?? current[index],
        answered?.data?.remix,
        !answered && !!current[index]?.data?.errors?.remix
      );
    }),
  };
}
