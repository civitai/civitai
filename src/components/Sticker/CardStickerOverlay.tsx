import { useEffect, useRef, useState } from 'react';
import { StickerPlacementOverlay } from '~/components/Sticker/StickerPlacementOverlay';
import { useStickerPlacementBatch } from '~/components/Sticker/StickerPlacementBatchProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';

type Box = { width: number; height: number; left: number; top: number };

const same = (a: Box | null, b: Box) =>
  !!a && a.width === b.width && a.height === b.height && a.left === b.left && a.top === b.top;

/**
 * Placed stickers on a feed card.
 *
 * Positions are fractions of the artwork's bounds, so the overlay has to be the
 * rectangle the artwork was actually scaled to — then clipped by the card.
 *
 * **That rectangle is measured off the media element, not computed.** Card media
 * is `object-fit: cover`, but the two card templates lay it out differently
 * enough that the resulting box differs: one stretches the image to the card
 * width inside a flex column, the other lets `height: 100%; width: auto`
 * overflow a block box, which anchors the crop left instead of centring it.
 * Reproducing that in arithmetic means encoding both templates' CSS here and
 * being wrong the day either changes — silently, and only for the class of
 * images whose aspect ratio makes the difference visible. Reading the element's
 * own rect is correct for whatever the stylesheet does.
 *
 * A consequence worth knowing rather than fixing: `cover` crops, so a sticker
 * placed low on a tall image is outside the visible box and not shown in a feed.
 */
export function CardStickerOverlay({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const revealed = useStickerRevealStore((state) => state.revealed);
  const batch = useStickerPlacementBatch(imageId);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);

  const placements = batch
    ? revealed
      ? batch.placements
      : // Pending rows are scoped server-side to the placer and the owner, so
        // anything pending here belongs to whoever is looking at it — and they
        // have a decision to make, which the reveal toggle should not hide.
        batch.pending
    : [];

  const hasPlacements = placements.length > 0;

  useEffect(() => {
    const node = ref.current;
    if (!node || !hasPlacements) return;

    // The media is a sibling subtree, not a child of the overlay: the overlay
    // must sit above it, and nesting inside the link would make it part of the
    // card's click target.
    const media = node.parentElement?.querySelector('img, video');
    if (!media) return;

    const measure = () => {
      const outer = node.getBoundingClientRect();
      const inner = media.getBoundingClientRect();
      if (inner.width <= 0 || inner.height <= 0) return;
      const next = {
        width: inner.width,
        height: inner.height,
        left: inner.left - outer.left,
        top: inner.top - outer.top,
      };
      // Rects come back fractional and a ResizeObserver fires on every layout
      // pass, so setting state unconditionally re-renders the whole overlay
      // continuously on any page that animates the card (these scale on hover).
      setBox((current) => (same(current, next) ? current : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(media);
    return () => observer.disconnect();
  }, [hasPlacements]);

  if (!hasPlacements) return null;

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
