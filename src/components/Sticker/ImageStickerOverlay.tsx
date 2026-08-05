import { useMemo } from 'react';
import { StickerPlacementOverlay } from '~/components/Sticker/StickerPlacementOverlay';
import { useStickerPlacements } from '~/components/Sticker/placement.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';

/**
 * Drops the overlay onto one image, sized to the rendered media box rather than
 * to its container — a letterboxed image and its container are different
 * rectangles, and positioning against the wrong one puts every sticker in the
 * wrong place on exactly the images where it is hardest to notice.
 *
 * Nothing is fetched until the viewer has revealed stickers. The reveal is
 * sticky and site-wide, so this costs one request for the session rather than
 * one per image for everyone.
 */
export function ImageStickerOverlay({
  imageId,
  width,
  height,
}: {
  imageId: number;
  width: number;
  height: number;
}) {
  const currentUser = useCurrentUser();
  const revealed = useStickerRevealStore((state) => state.revealed);

  const imageIds = useMemo(() => [imageId], [imageId]);
  const { byImage } = useStickerPlacements(imageIds, revealed);

  const placements = byImage.get(imageId) ?? [];
  if (!revealed || !placements.length || width <= 0 || height <= 0) return null;

  return (
    <div
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ width, height }}
    >
      <StickerPlacementOverlay placements={placements} viewerId={currentUser?.id} />
    </div>
  );
}
