import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DraftStickerLayer } from '~/components/Sticker/DraftStickerLayer';
import { StickerPlacementOverlay } from '~/components/Sticker/StickerPlacementOverlay';
import { useStickerPlacements } from '~/components/Sticker/placement.util';
import { useStickerTreatment } from '~/components/Sticker/treatments/useStickerTreatment';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
import { useStickerRevealStore } from '~/store/sticker-reveal.store';
import { useStickerHistoryStep } from '~/store/sticker-history.store';

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
  const treatment = useStickerTreatment();
  const revealed = useStickerRevealStore((state) => state.revealed);
  const targetImageId = useStickerPlacementDraftStore((state) => state.targetImageId);
  const setSurface = useStickerPlacementDraftStore((state) => state.setSurface);

  const historyStep = useStickerHistoryStep(imageId);

  const isPlacing = targetImageId === imageId;
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // The element as state as well as a ref: the overlay renders nothing until it
  // has placements, so the node arrives on a later render than the first, and an
  // effect reading only the ref would observe `null` and never look again.
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);
  const attachSurface = useCallback((node: HTMLDivElement | null) => {
    surfaceRef.current = node;
    setSurfaceEl(node);
  }, []);

  // Registered while this image is the placement target, and cleared on the way
  // out: a stale surface would have the next drag measured against a box that is
  // no longer on screen.
  useEffect(() => {
    if (!isPlacing) return;
    setSurface(surfaceRef.current);
    return () => setSurface(null);
  }, [isPlacing, setSurface]);

  // The reveal is a mount-time CSS animation, and mounting is not the same event
  // as being looked at: the carousel keeps both neighbouring slides mounted, so
  // an overlay two slides away plays its whole reveal off-screen and is already
  // settled by the time anyone swipes to it. Arming on first intersection is
  // what makes "every time they become visible" true for every slide rather
  // than only for the one the page opened on.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!surfaceEl || armed || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setArmed(true);
      },
      // A slide is either the one on screen or entirely off it, so anything
      // above zero separates them. Not 0: the carousel holds neighbours
      // adjacent, and a hairline overlap during a drag is not arrival.
      { threshold: 0.25 }
    );
    observer.observe(surfaceEl);
    return () => observer.disconnect();
  }, [armed, surfaceEl]);

  const imageIds = useMemo(() => [imageId], [imageId]);
  // Signed-in viewers always fetch, because a pending placement is something
  // they either paid for or have been asked to answer — and the notification
  // sends the owner straight here. Gating this on `revealed` meant the owner
  // followed the link to an image that looked untouched, with no control on the
  // page that would have shown them the thing they came to decide on.
  const { byImage } = useStickerPlacements(imageIds, revealed || isPlacing || !!currentUser);

  const all = byImage.get(imageId) ?? [];
  // Off means off, pending included. The owner still finds a pending placement
  // because the count chip counts it and toggles reveal — the fetch above stays
  // ungated so that total is right, which is the part the notification path
  // actually depends on.
  // A replay in progress shows them regardless: stepping through the history
  // with the reveal off would drive a panel against a blank image, and the
  // person stepping has already asked for exactly this.
  const placements = revealed || isPlacing || historyStep != null ? all : [];

  if (!placements.length && !isPlacing) return null;
  if (width <= 0 || height <= 0) return null;

  return (
    <div
      ref={attachSurface}
      className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      style={{ width, height }}
    >
      {placements.length > 0 && (
        <StickerPlacementOverlay
          placements={placements}
          viewerId={currentUser?.id}
          treatment={treatment}
          // Every time they become visible, not once per image (Justin,
          // 2026-08-12) — hence `armed`, which is first intersection rather
          // than mount, because the carousel mounts a slide long before anyone
          // looks at it.
          //
          // Not while placing. Watching the existing stickers replay under the
          // sticker you are dragging is movement in the one moment the surface
          // has to hold still.
          stagger={armed && !isPlacing}
          step={historyStep}
        />
      )}
      {isPlacing && <DraftStickerLayer />}
    </div>
  );
}
