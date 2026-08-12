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
 * How much of the slide has to be on screen before its stickers start arriving.
 *
 * Most of it, not a sliver: the reveal is worth watching from the moment the
 * slide is the thing you are looking at, and starting it mid-transition spends
 * it on a strip of image sliding past.
 */
const ARM_AT = 0.6;

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

  // Mounting is not the same event as being looked at: the carousel keeps the
  // slide either side mounted, so an overlay that armed on mount would play its
  // whole reveal off-screen and be settled before anyone swiped to it. Arming on
  // intersection — and disarming when the slide leaves — is what makes "every
  // time they become visible" true for arriving at a slide, going next, and
  // coming back.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!surfaceEl) return;

    // No observer means no way to tell arrival from mounting, and the stickers
    // are held at zero opacity until armed — so the failure has to be "reveal
    // immediately", never "stay hidden".
    if (typeof IntersectionObserver === 'undefined') {
      setArmed(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Two thresholds rather than one, and it keeps observing after the
        // first: leaving the screen disarms, so coming back reveals again.
        // Without that, arriving at a slide a second time showed the stickers
        // already settled — the carousel keeps the slide either side mounted,
        // so stepping right and back again never remounts anything, and a
        // one-shot arm has nothing left to play.
        if (entry.intersectionRatio >= ARM_AT) setArmed(true);
        else if (entry.intersectionRatio === 0) setArmed(false);
      },
      // The gap between the two is deliberate. Arming at a sliver meant the
      // reveal ran while the slide was still sliding in — and a drag nudged a
      // few percent and released armed a neighbour that then played its whole
      // reveal off-screen. Disarming only at nothing-visible stops the pair
      // flickering while a drag hovers around the boundary.
      { threshold: [0, ARM_AT] }
    );
    observer.observe(surfaceEl);
    return () => observer.disconnect();
  }, [surfaceEl]);

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
          // Every time they arrive on screen (Justin, 2026-08-12) — hence
          // `armed`, which is first intersection rather than mount, because the
          // carousel mounts a slide long before anyone looks at it. It does not
          // disarm, so coming back to a slide you have already seen draws them
          // straight away; nothing remounts on the way back, so there is no
          // arrival to play.
          //
          // `stagger` is what this surface does and never changes while it is
          // mounted; `armed` is whether it has been seen. Held apart because
          // collapsing them paints an un-staggered frame before the reveal can
          // start, which reads as a blink. For the same reason this is not
          // `!isPlacing`: flipping it off and back on as a placement session
          // starts and ends re-adds the animation to stickers already on screen
          // and replays the whole reveal under the sticker being dragged.
          stagger
          armed={armed}
          // The sequence is what has to stop while a placement is in progress,
          // not the reveal itself — three seconds of stickers arriving one by
          // one under the sticker being positioned is movement where the
          // surface has to hold still, and reveal is off by default, so
          // pressing the plus is often what mounts this in the first place.
          paced={!isPlacing}
          step={historyStep}
        />
      )}
      {isPlacing && <DraftStickerLayer />}
    </div>
  );
}
