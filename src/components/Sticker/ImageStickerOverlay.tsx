import { useEffect, useMemo, useRef } from 'react';
import { DraftStickerLayer } from '~/components/Sticker/DraftStickerLayer';
import { StickerPlacementOverlay } from '~/components/Sticker/StickerPlacementOverlay';
import { useStickerPlacements } from '~/components/Sticker/placement.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';

/**
 * The overlay for one image: placed stickers, and the one being positioned.
 *
 * Sized to the rendered media box rather than to its container — a letterboxed
 * image and its container are different rectangles, and positioning against the
 * wrong one misplaces every sticker on exactly the images where it is hardest to
 * notice. This element *is* the coordinate system, so it is what the draft store
 * measures drags against.
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
  const targetImageId = useStickerPlacementDraftStore((state) => state.targetImageId);
  const setSurface = useStickerPlacementDraftStore((state) => state.setSurface);

  const isPlacing = targetImageId === imageId;
  const surfaceRef = useRef<HTMLDivElement>(null);

  // Registered while this image is the placement target, and cleared on the way
  // out: a stale surface would have the next drag measured against a box that is
  // no longer on screen.
  useEffect(() => {
    if (!isPlacing) return;
    setSurface(surfaceRef.current);
    return () => setSurface(null);
  }, [isPlacing, setSurface]);

  const imageIds = useMemo(() => [imageId], [imageId]);
  // Placing implies looking: someone positioning a sticker has to see what is
  // already there, whatever their reveal setting says.
  const { byImage } = useStickerPlacements(imageIds, revealed || isPlacing);

  const placements = byImage.get(imageId) ?? [];
  const showPlacements = (revealed || isPlacing) && placements.length > 0;

  if (!showPlacements && !isPlacing) return null;
  if (width <= 0 || height <= 0) return null;

  return (
    <div
      ref={surfaceRef}
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ width, height }}
    >
      {showPlacements && (
        <StickerPlacementOverlay placements={placements} viewerId={currentUser?.id} />
      )}
      {isPlacing && <DraftStickerLayer />}
    </div>
  );
}
