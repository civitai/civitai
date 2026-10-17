import { useEffect, useRef, useState } from 'react';
import { offsetWithin } from '~/components/Sticker/CardStickerOverlay';
import { mediaContentRectOf } from '~/components/Sticker/media-content-rect';

/** Marks an overlay host, so the next overlay's host looks past it for the media. */
export const MEDIA_OVERLAY_ATTR = 'data-media-overlay';

export type DrawnMediaBox = { width: number; height: number; left: number; top: number };

const same = (a: DrawnMediaBox | null, b: DrawnMediaBox) =>
  !!a && a.width === b.width && a.height === b.height && a.left === b.left && a.top === b.top;

/**
 * The box a piece of media is actually drawn in, relative to `hostRef`'s element, for an overlay
 * that has to sit on the picture rather than on its container: a letterboxed image and its
 * container are different rectangles, and positioning against the wrong one misplaces the overlay
 * on exactly the images where it is hardest to notice.
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
 * The host expects to come AFTER the media (or the media's wrapper) inside a positioned parent,
 * which is how `ImageContent` lays it out, with only other hosts carrying MEDIA_OVERLAY_ATTR
 * between them.
 */
export function useDrawnMediaBox(active: boolean) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<DrawnMediaBox | null>(null);

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
      let before = host.previousElementSibling as HTMLElement | null;
      // Other overlays on the same media (stickers, a hat) sit between it and this host.
      while (before?.hasAttribute(MEDIA_OVERLAY_ATTR))
        before = before.previousElementSibling as HTMLElement | null;
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

  return { hostRef, box };
}
