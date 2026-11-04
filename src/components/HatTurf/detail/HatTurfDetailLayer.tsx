import { HatTurfLayer } from '~/components/HatTurf/HatTurfLayer';
import { HatTurfDetailBadge } from '~/components/HatTurf/detail/HatTurfDetailControls';
import { useImageTurfStickers } from '~/components/HatTurf/detail/useImageTurfStickers';
import { trpc } from '~/utils/trpc';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';

/** The most hats drawn on a picture before "+N more". Matches the server's render cap. */
const DRAW_LIMIT = 12;

/** Mounted in the on-screen slide only, so a swipe never shows a neighbour's draft. */
export function HatTurfDetailLayer({ imageId }: { imageId: number }) {
  return useTurfFeed()?.joined ? <Content imageId={imageId} /> : null;
}

function Content({ imageId }: { imageId: number }) {
  const { stickers, loadedExtra, loadMore, loading } = useImageTurfStickers(imageId);
  const utils = trpc.useUtils();
  return (
    <HatTurfLayer
      imageId={imageId}
      source="image-detail"
      stickers={stickers ?? []}
      drawLimit={DRAW_LIMIT + loadedExtra}
      onMore={loadMore}
      moreLoading={loading}
      onPlaced={() => void utils.hatTurf.getImageStickers.invalidate()}
      corner={<HatTurfDetailBadge imageId={imageId} />}
    />
  );
}
