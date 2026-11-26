import { HatTurfLayer } from '~/components/HatTurf/HatTurfLayer';
import { useImageTurfStickers } from '~/components/HatTurf/detail/useImageTurfStickers';
import { useHatTurfCard } from '~/components/HatTurf/HatTurfCardProvider';
import { trpc } from '~/utils/trpc';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';

/** Mounted in the on-screen slide only, so a swipe never shows a neighbour's draft. */
export function HatTurfDetailLayer({ imageId }: { imageId: number }) {
  const feed = useTurfFeed();
  return feed?.joined ? <Content imageId={imageId} /> : null;
}

function Content({ imageId }: { imageId: number }) {
  const { stickers, own: ownPaged, drawCeiling, loadMore, loading } = useImageTurfStickers(imageId);
  const utils = trpc.useUtils();
  // A hat placed this visit is drawn by the layer itself.
  const own = useHatTurfCard()?.placed ? undefined : ownPaged;
  // Every hat loaded is drawn, up to the ceiling; past it the rest are counted and not offered. Counted
  // in hats, not pages: a page that held the viewer's own hat brings one fewer. No ceiling from an
  // older server.
  const ceiling = drawCeiling ?? Infinity;
  const all = stickers ?? [];
  const limit = Math.min(all.length, ceiling);
  // The viewer's own hat goes right after the others drawn, so it is drawn, last and on top.
  const drawnFirst = own ? [...all.slice(0, limit), own, ...all.slice(limit)] : all;
  return (
    <HatTurfLayer
      imageId={imageId}
      source="image-detail"
      stickers={drawnFirst}
      drawLimit={limit + (own ? 1 : 0)}
      onMore={all.length < ceiling ? loadMore : undefined}
      moreLoading={loading}
      onPlaced={() => void utils.hatTurf.getImageStickers.invalidate()}
    />
  );
}
