import { useEffect, useMemo, useRef, useState } from 'react';
import { offsetWithin } from '~/components/Sticker/CardStickerOverlay';
import { DraftStickerLayer } from '~/components/Sticker/DraftStickerLayer';
import { mediaContentRectOf } from '~/components/Sticker/media-content-rect';
import { StickerPlacementOverlay } from '~/components/Sticker/StickerPlacementOverlay';
import { useStickerPlacements } from '~/components/Sticker/placement.util';
import { useStickerTreatment } from '~/components/Sticker/treatments/useStickerTreatment';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
import { stickersRevealed, useStickerRevealStore } from '~/store/sticker-reveal.store';
import { useStickerHistoryStep } from '~/store/sticker-history.store';

/**
 * How much of the slide has to be on screen before its stickers start arriving.
 *
 * Most of it, not a sliver: the reveal is worth watching from the moment the
 * slide is the thing you are looking at, and starting it mid-transition spends
 * it on a strip of image sliding past.
 */
const ARM_AT = 0.6;

type Box = { width: number; height: number; left: number; top: number };

const same = (a: Box | null, b: Box) =>
  !!a && a.width === b.width && a.height === b.height && a.left === b.left && a.top === b.top;

/**
 * The overlay for one image: placed stickers, and the one being positioned.
 *
 * Sized to the rendered media box rather than to its container — a letterboxed
 * image and its container are different rectangles, and positioning against the
 * wrong one misplaces every sticker on exactly the images where it is hardest to
 * notice. The box *is* the coordinate system, so it is what the draft store
 * measures drags against and what every stored fraction means.
 *
 * 🔴 MEASURED OFF THE MEDIA ELEMENT, NOT COMPUTED FROM THE IMAGE'S STORED SIZE.
 * It used to be handed a pixel box worked out once at mount and again on a
 * window `resize`. The sidebar closing after mount, a footer that grows when its
 * data arrives, or a bottom sheet moves the media without either, and the two
 * boxes then disagree: a sticker placed against the stale one is saved as a
 * fraction of the wrong rectangle, and every viewer whose box is right sees it
 * somewhere else. The media element is the only thing that is always the box the
 * picture is drawn in.
 *
 * Expects to be the sibling directly AFTER the media (or the media's wrapper)
 * inside a positioned parent, which is how `ImageContent` lays it out.
 */
export function ImageStickerOverlay({ imageId }: { imageId: number }) {
  const currentUser = useCurrentUser();
  const treatment = useStickerTreatment();
  const revealed = useStickerRevealStore(stickersRevealed);
  const targetImageId = useStickerPlacementDraftStore((state) => state.targetImageId);
  const setSurface = useStickerPlacementDraftStore((state) => state.setSurface);

  const historyStep = useStickerHistoryStep(imageId);

  const isPlacing = targetImageId === imageId;
  // State rather than a ref: the surface mounts only once the media has been
  // measured, so the node arrives on a later render than the first, and an effect
  // reading a ref would observe `null` and never look again.
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);

  // Registered while this image is the placement target, and cleared on the way
  // out: a stale surface would have the next drag measured against a box that is
  // no longer on screen. Off the element state, not the ref: the surface mounts
  // only once the media has been measured, which is after the render that set
  // `isPlacing`.
  useEffect(() => {
    if (!isPlacing || !surfaceEl) return;
    setSurface(surfaceEl);
    return () => setSurface(null);
  }, [isPlacing, surfaceEl, setSurface]);

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
  // they either paid for or have been asked to answer. Gating this on `revealed`
  // meant arriving at an image that looked untouched, with no control on the
  // page that would have shown them the thing they came for — the count chip
  // needs the total before it can offer to reveal anything.
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

  const active = placements.length > 0 || isPlacing;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    // Cleared with the host, so a later session does not paint (and register as
    // the drag surface) a box measured before the layout last changed.
    if (!active || !host) {
      setBox(null);
      return;
    }

    let bound: HTMLElement | null = null;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      const element = bound;
      if (!element || element.offsetWidth <= 0 || element.offsetHeight <= 0) return;
      // An image with no decoded picture (still loading, or failed) has a layout
      // box but no artwork, and a failed one draws its broken-image placeholder
      // there: a placement made against that is stored against a rectangle nobody
      // else sees. The `load` listener measures again once there is a picture.
      if (element instanceof HTMLImageElement && element.naturalWidth === 0) return;

      const stop = host.offsetParent;
      const at = offsetWithin(element, stop);
      const self = offsetWithin(host, stop);
      if (!at || !self) return;

      // An embed has no natural size to fit, and its visible box is its border
      // box: a padding-ratio wrapper is zero tall in its content box.
      const drawn =
        element instanceof HTMLImageElement || element instanceof HTMLVideoElement
          ? mediaContentRectOf(element)
          : { width: element.offsetWidth, height: element.offsetHeight, left: 0, top: 0 };
      const next = {
        width: drawn.width,
        height: drawn.height,
        left: at.x - self.x + drawn.left,
        top: at.y - self.y + drawn.top,
      };
      // A ResizeObserver fires on every layout pass; setting state unconditionally
      // would re-render the overlay continuously while the carousel animates.
      setBox((current) => (same(current, next) ? current : next));
    };

    const findMedia = () => {
      const before = host.previousElementSibling as HTMLElement | null;
      if (!before) return null;
      if (before.matches('img, video')) return before;
      // Falls back to the sibling itself for an embed with no `img`/`video` in
      // it, which is the box it is drawn in.
      return before.querySelector<HTMLElement>('img, video') ?? before;
    };

    const unbind = () => {
      observer?.disconnect();
      observer = null;
      if (!bound) return;
      bound.removeEventListener('load', measure);
      bound.removeEventListener('loadedmetadata', measure);
      bound.removeEventListener('resize', measure);
      bound = null;
    };

    // The media is replaced as well as resized (an image becoming a video, a
    // changed src remounting it), and an observer bound once would stay on the
    // detached node and keep the last box forever with no error.
    const bind = () => {
      const media = findMedia();
      if (media === bound) return;

      unbind();
      bound = media;
      if (!media) return;

      observer = new ResizeObserver(measure);
      observer.observe(host);
      observer.observe(media);
      // The natural size arrives with the file, and no ResizeObserver fires for
      // it; it only matters if the media is ever cropped by `object-fit`.
      media.addEventListener('load', measure);
      media.addEventListener('loadedmetadata', measure);
      media.addEventListener('resize', measure);

      measure();
    };

    bind();

    const swaps = new MutationObserver(bind);
    if (host.parentElement) swaps.observe(host.parentElement, { childList: true, subtree: true });

    return () => {
      swaps.disconnect();
      unbind();
    };
  }, [active]);

  if (!active) return null;

  return (
    <div ref={hostRef} className="pointer-events-none absolute inset-0">
      {box && (
        <div ref={setSurfaceEl} className="pointer-events-none absolute isolate" style={box}>
          {placements.length > 0 && (
            <StickerPlacementOverlay
              placements={placements}
              viewerId={currentUser?.id}
              treatment={treatment}
              // Every time they arrive on screen (Justin, 2026-08-12) — hence
              // `armed`, which tracks intersection rather than mount, because the
              // carousel mounts a slide long before anyone looks at it and keeps it
              // mounted long after.
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
      )}
    </div>
  );
}
