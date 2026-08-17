import { useEffect, useRef, useState } from 'react';
import { offsetWithin } from '~/components/Sticker/CardStickerOverlay';
import { StickerPlacementOverlay } from '~/components/Sticker/StickerPlacementOverlay';
import { useStickerPlacementBatch } from '~/components/Sticker/StickerPlacementBatchProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';

type Box = { width: number; height: number; left: number; top: number };

/** Matches `ImageStickerOverlay`: most of the image on screen, not a sliver. */
const ARM_AT = 0.6;

const same = (a: Box | null, b: Box) =>
  !!a && a.width === b.width && a.height === b.height && a.left === b.left && a.top === b.top;

/**
 * Placed stickers on a post page image. Display only — no placing from here.
 *
 * Measured off the media element rather than stretched over the container, but
 * for a different reason than the feed card's: a post has no hover transform and
 * no `object-fit: cover`, so the container's own box is nearly right. Nearly —
 * the media is wrapped in a `RoutedDialogLink`, which renders an inline anchor,
 * and an inline box around an image carries the line-box descender gap. That
 * makes the container a few pixels taller than the artwork, which tilts every
 * vertical fraction by an amount that is invisible on a square image and wrong
 * on a tall one.
 *
 * `artworkWidth` is left at `StickerPlacementOverlay`'s 512 rather than the
 * card's 256: a post image draws at up to `MAX_POST_IMAGES_WIDTH` (800), where a
 * default-capped sticker wants ~400 device pixels on a DPR-2 display.
 */
export function PostStickerOverlay({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const revealed = useStickerRevealStore((state) => state.revealed);
  const batch = useStickerPlacementBatch(imageId);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);

  // Off means off, pending included — same rule as the feed card. The chip
  // beside the reactions still counts the viewer's own pending, so an owner who
  // arrived from a notification has one press to what they came for.
  const placements = batch && revealed ? batch.placements : [];

  const hasPlacements = placements.length > 0;

  useEffect(() => {
    const node = ref.current;
    if (!node || !hasPlacements) return;

    // The media is a sibling subtree: nesting the overlay inside the link would
    // make it part of the link's click target.
    const media = node.parentElement?.querySelector('img, video');
    if (!media) return;

    const measure = () => {
      const element = media as HTMLElement;
      if (element.offsetWidth <= 0 || element.offsetHeight <= 0) return;

      const stop = node.offsetParent;
      const at = offsetWithin(element, stop);
      const self = offsetWithin(node, stop);
      if (!at || !self) return;

      const next = {
        width: element.offsetWidth,
        height: element.offsetHeight,
        left: at.x - self.x,
        top: at.y - self.y,
      };
      setBox((current) => (same(current, next) ? current : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(media);
    return () => observer.disconnect();
  }, [hasPlacements]);

  // A post is a scroll, so an overlay that armed on mount would play its whole
  // reveal for an image still thousands of pixels below the fold and be settled
  // before anyone reached it.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || !hasPlacements) return;

    // Stickers are held at zero opacity until armed, so the failure without an
    // observer has to be "reveal immediately", never "stay hidden".
    if (typeof IntersectionObserver === 'undefined') {
      setArmed(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Keeps observing after the first hit: scrolling an image away disarms
        // it, so scrolling back reveals again.
        if (entry.intersectionRatio >= ARM_AT) setArmed(true);
        else if (entry.intersectionRatio === 0) setArmed(false);
      },
      { threshold: [0, ARM_AT] }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasPlacements]);

  // Narrows `batch` as well: `placements` is empty without one.
  if (!batch || !hasPlacements) return null;

  return (
    <div ref={ref} className="pointer-events-none absolute inset-0 overflow-hidden">
      {box && (
        <div className="pointer-events-none absolute" style={box}>
          <StickerPlacementOverlay
            placements={placements}
            viewerId={currentUser?.id}
            interactive={false}
            sticker={batch.sticker}
            treatment={batch.treatment}
            surface="detail"
            stagger
            armed={armed}
          />
        </div>
      )}
    </div>
  );
}
