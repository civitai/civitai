import { useEffect, useRef, useState } from 'react';
import { offsetWithin } from '~/components/Sticker/CardStickerOverlay';
import { mediaContentRectOf } from '~/components/Sticker/media-content-rect';
import { StickerPlacementOverlay } from '~/components/Sticker/StickerPlacementOverlay';
import { useStickerPlacementBatch } from '~/components/Sticker/StickerPlacementBatchProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { stickersRevealed, useStickerRevealStore } from '~/store/sticker-reveal.store';

type Box = { width: number; height: number; left: number; top: number };

/** Matches `ImageStickerOverlay`: most of the image on screen, not a sliver. */
const ARM_AT = 0.6;

const same = (a: Box | null, b: Box) =>
  !!a && a.width === b.width && a.height === b.height && a.left === b.left && a.top === b.top;

/**
 * Placed stickers on a post page image. Display only — no placing from here.
 *
 * Sized to the media element, not to the container. A placement is a fraction of
 * the artwork's bounds, and the container's height is derived from the image's
 * *stored* dimensions (`PostImages.tsx` sets `aspectRatio` from
 * `image.width`/`image.height`) — a different source of truth from the file the
 * CDN actually serves, and only the served file is what a fraction means.
 *
 * Measured rather than assumed, on `/posts/30077020` (a 1006x1520 image): the
 * container and the media are the same box, 1100px both, with and without that
 * `aspectRatio`. The `RoutedDialogLink` anchor computes to `display: inline`,
 * but it contributes no descender gap, because Tailwind's preflight makes `img`
 * a block. So this is not correcting a divergence that exists today; it is
 * declining to depend on two sources agreeing.
 *
 * `artworkWidth` is left at `StickerPlacementOverlay`'s 512 rather than the
 * card's 256: a post image draws at up to `MAX_POST_IMAGES_WIDTH` (800), where a
 * default-capped sticker wants ~400 device pixels on a DPR-2 display.
 */
export function PostStickerOverlay({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const revealed = useStickerRevealStore(stickersRevealed);
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

    // The link immediately before this overlay, not the whole container: the
    // overlay is a sibling of the link because nesting it inside would make it
    // part of the link's click target, and searching the container instead
    // would take the first `img`/`video` in document order — which is whatever
    // the control group above the media happens to render.
    const media = node.previousElementSibling?.querySelector('img, video');
    if (!media) return;

    const measure = () => {
      const element = media as HTMLElement;
      if (element.offsetWidth <= 0 || element.offsetHeight <= 0) return;

      const stop = node.offsetParent;
      const at = offsetWithin(element, stop);
      const self = offsetWithin(node, stop);
      if (!at || !self) return;

      // A post image is not cropped today — nothing here sets `object-fit`, so
      // this resolves to the element box and the behaviour is unchanged. It goes
      // through the same helper as the card overlay anyway, because the two
      // measure the same thing and the card's copy was silently wrong under a
      // crop for as long as both existed.
      const drawn = mediaContentRectOf(element);

      const next = {
        width: drawn.width,
        height: drawn.height,
        left: at.x - self.x + drawn.left,
        top: at.y - self.y + drawn.top,
      };
      setBox((current) => (same(current, next) ? current : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    observer.observe(media);

    // The natural size arrives with the file, and no ResizeObserver fires for
    // it. Harmless here while nothing crops; correct if anything ever does.
    media.addEventListener('load', measure);
    media.addEventListener('loadedmetadata', measure);

    return () => {
      observer.disconnect();
      media.removeEventListener('load', measure);
      media.removeEventListener('loadedmetadata', measure);
    };
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
