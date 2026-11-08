import { HatTurfLayer } from '~/components/HatTurf/HatTurfLayer';
import { useImageTurfStickers } from '~/components/HatTurf/detail/useImageTurfStickers';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import { trpc } from '~/utils/trpc';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';

/** The most hats drawn on a picture before "+N more". Matches the server's render cap. */
const DRAW_LIMIT = 12;

/** Mounted in the on-screen slide only, so a swipe never shows a neighbour's draft. */
export function HatTurfDetailLayer({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  return feed?.joined ? <Content imageId={imageId} /> : null;
}

function Content({ imageId }: { imageId: number }) {
  const {
    stickers,
    own: ownPaged,
    drawCeiling,
    loadedExtra,
    loadMore,
    loading,
  } = useImageTurfStickers(imageId);
  const utils = trpc.useUtils();
  // A hat placed this visit is drawn by the layer itself.
  const own = useHatTurfCard()?.placed ? undefined : ownPaged;
  // Past the ceiling more hats are counted, not drawn, and not offered. A server without one has none.
  const ceiling = drawCeiling ?? Infinity;
  const limit = Math.min(DRAW_LIMIT + loadedExtra, ceiling);
  const all = stickers ?? [];
  // The viewer's own hat goes right after the others drawn, so it is drawn, last and on top.
  const drawnFirst = own ? [...all.slice(0, limit), own, ...all.slice(limit)] : all;
  return (
    <HatTurfLayer
      imageId={imageId}
      source="image-detail"
      stickers={drawnFirst}
      drawLimit={limit + (own ? 1 : 0)}
      onMore={DRAW_LIMIT + loadedExtra < ceiling ? loadMore : undefined}
      moreLoading={loading}
      onPlaced={() => void utils.hatTurf.getImageStickers.invalidate()}
    />
  );
}
