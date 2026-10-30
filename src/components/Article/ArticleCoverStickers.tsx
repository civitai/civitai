import { CardStickerOverlay } from '~/components/Sticker/CardStickerOverlay';
import { StickerPlacementBatchProvider } from '~/components/Sticker/StickerPlacementBatchProvider';
import { StickerPlacementCardBadge } from '~/components/Sticker/StickerPlacementCardBadge';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * A cover is drawn at the article page's full width, so a default-sized sticker
 * lands near 330 CSS px — 660 device px on a DPR-2 display. The card overlay's
 * own 256 would upscale artwork a creator was paid for.
 */
const COVER_ARTWORK_WIDTH = 512;

/**
 * Placed stickers on an article cover, and the viewer's reveal toggle.
 *
 * Its own component rather than JSX in the page so the gate below is reachable
 * by a test: `safe` is a boolean whose deletion no type checks, and dropping it
 * would draw someone else's cosmetic over a cover the viewer's browsing level
 * blurred.
 *
 * Renders nothing until the media is safe, which is also why the batch fetch
 * lives inside the gate rather than around it — a blurred cover asks for no
 * placements at all.
 */
export function ArticleCoverStickers({ imageId, safe }: { imageId: number; safe: boolean }) {
  const features = useFeatureFlags();
  if (!safe || !features.stickerPlacement) return null;

  return (
    <StickerPlacementBatchProvider imageIds={[imageId]}>
      <CardStickerOverlay imageId={imageId} artworkWidth={COVER_ARTWORK_WIDTH} />
      <StickerPlacementCardBadge imageId={imageId} className="absolute bottom-2 right-2 z-10" />
    </StickerPlacementBatchProvider>
  );
}
