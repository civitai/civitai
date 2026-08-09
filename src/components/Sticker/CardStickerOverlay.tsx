import { useCallback, useState } from 'react';
import { StickerPlacementOverlay } from '~/components/Sticker/StickerPlacementOverlay';
import { useStickerPlacementBatch } from '~/components/Sticker/StickerPlacementBatchProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';

type Box = { width: number; height: number; left: number; top: number };

/**
 * Placed stickers on a feed card.
 *
 * Card media is `object-fit: cover` with `object-position: top center`, so the
 * rendered artwork is *larger* than the card and cropped by it — not
 * letterboxed the way the detail view is. Positions are fractions of the
 * artwork's bounds, so the overlay has to be the same rectangle the artwork was
 * scaled to, and then clipped. Sizing it to the card instead would slide every
 * sticker relative to the thing it was placed on, worst on exactly the images
 * whose aspect ratio differs most from the card's.
 *
 * A consequence worth knowing rather than fixing: a sticker placed low on a tall
 * image is outside the crop and therefore not visible in the feed at all.
 */
export function CardStickerOverlay({
  imageId,
  width,
  height,
}: {
  imageId: number;
  width?: number | null;
  height?: number | null;
}) {
  const currentUser = useCurrentUser();
  const revealed = useStickerRevealStore((state) => state.revealed);
  const batch = useStickerPlacementBatch(imageId);
  const [box, setBox] = useState<Box | null>(null);

  const aspectRatio = width && height ? width / height : null;

  const measure = useCallback(
    (entry: ResizeObserverEntry) => {
      if (!aspectRatio) return;
      const { width: cw, height: ch } = entry.contentRect;
      if (cw <= 0 || ch <= 0) return;

      const covered =
        aspectRatio > cw / ch
          ? { width: ch * aspectRatio, height: ch }
          : { width: cw, height: cw / aspectRatio };

      setBox({ ...covered, left: (cw - covered.width) / 2, top: 0 });
    },
    [aspectRatio]
  );

  const ref = useResizeObserver<HTMLDivElement>(measure);

  const placements = batch
    ? revealed
      ? batch.placements
      : // Pending rows are scoped server-side to the placer and the owner, so
        // anything pending here belongs to whoever is looking at it — and they
        // have a decision to make, which the reveal toggle should not hide.
        batch.pending
    : [];

  if (!aspectRatio || !placements.length) return null;

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 overflow-hidden">
      {box && (
        <div className="pointer-events-none absolute" style={box}>
          <StickerPlacementOverlay placements={placements} viewerId={currentUser?.id} />
        </div>
      )}
    </div>
  );
}
