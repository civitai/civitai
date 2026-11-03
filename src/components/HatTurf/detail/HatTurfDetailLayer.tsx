import { HatTurfLayer } from '~/components/HatTurf/HatTurfLayer';
import { useImageTurfStickers } from '~/components/HatTurf/detail/useImageTurfStickers';
import { trpc } from '~/utils/trpc';
import { useTurfFeed } from '~/components/HatTurf/TurfSummaryProvider';

/** The most hats drawn on a picture before "+N more". Matches the server's render cap. */
const DRAW_LIMIT = 12;

/** Mounted in the on-screen slide only, so a swipe never shows a neighbour's draft. */
export function HatTurfDetailLayer({ imageId }: { imageId: number }) {
  return useTurfFeed() ? <Content imageId={imageId} /> : null;
}

function Content({ imageId }: { imageId: number }) {
  const { stickers } = useImageTurfStickers(imageId);
  const utils = trpc.useUtils();
  return (
    <HatTurfLayer
      imageId={imageId}
      source="image-detail"
      stickers={stickers ?? []}
      drawLimit={DRAW_LIMIT}
      onPlaced={() => void utils.hatTurf.getImageStickers.invalidate()}
    />
  );
}
