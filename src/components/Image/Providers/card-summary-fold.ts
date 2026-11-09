import { useMemo } from 'react';
import { useRemixBatchRequest } from '~/components/RemixGallery/RemixGalleryBatchProvider';
import { useStickerBatchWants } from '~/components/Sticker/StickerPlacementBatchProvider';
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

/** Matches the `imageIds` cap on `getImageCardSummariesSchema`, and both batch providers' chunk. */
const CARD_SUMMARY_FETCH_CHUNK = 100;

type FoldQuery = {
  data?: ImageCardSummaries;
  isLoading: boolean;
  isError: boolean;
  dataUpdatedAt: number;
};

const chunkOf = <T>(query: FoldQuery | undefined, data: T | undefined): CardSummaryChunk<T> => ({
  data,
  isLoading: !!query?.isLoading,
  isError: !!query?.isError,
  dataUpdatedAt: query?.dataUpdatedAt ?? 0,
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
  const queries = trpc.useQueries((t) =>
    modes.flatMap((stickers) =>
      chunks.map((chunk) =>
        t.placement.getImageCardSummaries(
          { imageIds: chunk, stickers, remix: true, browsingLevel: remix.browsingLevel },
          { staleTime: 60_000, enabled: stickers === mode }
        )
      )
    )
  ) as unknown as FoldQuery[];
  const placementsQueries = queries.slice(0, chunks.length);
  const countsQueries = queries.slice(chunks.length);

  if (!active) return undefined;

  const [current, other] =
    mode === 'placements'
      ? [placementsQueries, countsQueries]
      : [countsQueries, placementsQueries];

  return {
    combined: chunks.map((_, index) =>
      chunkOf(
        placementsQueries[index],
        placementsQueries[index]?.data?.stickers as StickerPlacementBundle | undefined
      )
    ),
    countsOnly: chunks.map((_, index) =>
      chunkOf(countsQueries[index], countsQueries[index]?.data?.stickers?.counts)
    ),
    // The current mode's answer; the other mode's cached one for the same chunk
    // stands in until it lands, so a reveal does not blank the remix frames.
    remix: chunks.map((_, index) => {
      const answered = [current[index], other[index]].find((query) => query?.data?.remix);
      return chunkOf(answered ?? current[index], answered?.data?.remix);
    }),
  };
}
