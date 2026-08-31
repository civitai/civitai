import { useEffect, useRef, useState } from 'react';
import { mediaContentRectOf } from '~/components/Sticker/media-content-rect';
import { StickerPlacementOverlay } from '~/components/Sticker/StickerPlacementOverlay';
import { useStickerPlacementBatch } from '~/components/Sticker/StickerPlacementBatchProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { stickersRevealed, useStickerRevealStore } from '~/store/sticker-reveal.store';

type Box = { width: number; height: number; left: number; top: number };

/**
 * What a card asks the CDN for, against 512 on the detail view.
 *
 * A card is 450px wide and a sticker is capped at 0.25 of it by default (0.4 if
 * the creator raises it), so it draws at ~112 CSS px — but a DPR-2 display wants
 * 225 device px for that, and most laptops and phones are DPR 2+. 256 covers the
 * default ceiling on retina and is still a quarter of 512's pixels. The band
 * between 0.28 and the 0.4 maximum stays slightly soft, which is a creator
 * opt-in.
 *
 * The first version of this was 128, from arithmetic that left device pixel
 * ratio out and would have upscaled a default-size sticker by 1.8x — soft
 * artwork a creator was paid for.
 */
const CARD_ARTWORK_WIDTH = 256;

/**
 * The ceiling on the scaled request. 512 is what the image detail view asks for,
 * and a feed card has no business fetching sticker artwork larger than the page
 * that shows the sticker at full size.
 */
const MAX_ARTWORK_WIDTH = 512;

const same = (a: Box | null, b: Box) =>
  !!a && a.width === b.width && a.height === b.height && a.left === b.left && a.top === b.top;

/**
 * Layout position of `el` relative to `stop`, walking the offset chain.
 *
 * `offsetLeft`/`offsetTop` rather than `getBoundingClientRect`, because both
 * card templates scale the media on hover and a rect includes transforms while
 * a `ResizeObserver` does not fire on one. Measuring with a rect while the
 * pointer happened to be resting on the card — which is normal, it is the card
 * you are about to click — captures a box 5% too large and never corrects it.
 *
 * The two elements do not share an `offsetParent`: the media sits inside a
 * positioned link, the overlay is a sibling of that link. Hence the walk rather
 * than a subtraction of two `offsetLeft`s.
 */
export const offsetWithin = (el: HTMLElement, stop: Element | null) => {
  let x = 0;
  let y = 0;
  let current: HTMLElement | null = el;

  while (current && current !== stop) {
    x += current.offsetLeft;
    y += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }

  // Ran off the top without reaching `stop`, so the two are not in one offset
  // chain and any number here would be a guess.
  return current === stop ? { x, y } : null;
};

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
 * images whose aspect ratio makes the difference visible. Measuring the element
 * is correct for whatever the stylesheet does.
 *
 * A consequence worth knowing rather than fixing: `cover` crops, so a sticker
 * placed low on a tall image is outside the visible box and not shown in a feed.
 */
export function CardStickerOverlay({
  imageId,
  artworkWidth = CARD_ARTWORK_WIDTH,
  revealStickers,
}: {
  imageId: number;
  /**
   * Draw the placements whatever the viewer's site-wide reveal preference says.
   *
   * A prop rather than a read of `ImagesContext`: this component is mounted by
   * hosts that have no images provider at all, and reaching for one here would
   * pull the provider's module — and everything it imports — into every one of
   * them. A widener, so defaulting off is the correct absent value.
   */
  revealStickers?: boolean;
  /**
   * What the CDN is asked for, when the host draws the media wider than a card.
   * A sticker's drawn size is a fraction of the measured box, so a host with a
   * bigger box needs a bigger request or it upscales artwork someone was paid
   * for. `PostStickerOverlay` keeps 512 at 800px wide for the same reason.
   */
  artworkWidth?: number;
}) {
  const currentUser = useCurrentUser();
  const revealed = useStickerRevealStore(stickersRevealed) || !!revealStickers;
  const batch = useStickerPlacementBatch(imageId);
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);

  // Off means off, pending included. The badge still counts the viewer's own
  // pending, so an owner who came from a notification sees a non-zero chip, one
  // press from the thing they came to decide on.
  const placements = batch && revealed ? batch.placements : [];

  const hasPlacements = placements.length > 0;

  useEffect(() => {
    const node = ref.current;
    if (!node || !hasPlacements) return;

    const parent = node.parentElement;
    if (!parent) return;

    let bound: HTMLElement | null = null;
    let observer: ResizeObserver | null = null;

    const measure = () => {
      const element = bound;
      if (!element || element.offsetWidth <= 0 || element.offsetHeight <= 0) return;

      const stop = node.offsetParent;
      const at = offsetWithin(element, stop);
      const self = offsetWithin(node, stop);
      if (!at || !self) return;

      // The rectangle the ARTWORK occupies, which under `object-fit: cover` is
      // larger than the element and offset inside it. Positions are fractions of
      // the artwork, so the overlay has to be that rectangle; the wrapper's
      // `overflow-hidden` then crops it exactly as the card crops the picture.
      const drawn = mediaContentRectOf(element);

      const next = {
        width: drawn.width,
        height: drawn.height,
        left: at.x - self.x + drawn.left,
        top: at.y - self.y + drawn.top,
      };
      // A ResizeObserver fires on every layout pass, so setting state
      // unconditionally would re-render the overlay continuously on a page that
      // animates the card — and these do, on hover.
      setBox((current) => (same(current, next) ? current : next));
    };

    /**
     * 🔴 THE MEDIA ELEMENT IS REPLACED, NOT MERELY RESIZED.
     *
     * `EdgeMedia` renders an `<img>` instead of a `<video>` when the viewer
     * turns off animated media, and `EdgeVideo` keys on its src, so a changed
     * URL remounts it. This effect keys on `hasPlacements` and does not re-run
     * for either — so an observer bound once stays bound to a DETACHED node,
     * `measure` then early-returns on its zero-size guard forever, and the
     * overlay keeps its last box with a clean render and no error at all.
     */
    const bind = () => {
      const media = parent.querySelector<HTMLElement>('img, video');
      if (media === bound) return;

      unbind();
      bound = media;
      if (!media) return;

      observer = new ResizeObserver(measure);
      observer.observe(node);
      observer.observe(media);

      // The natural size arrives with the FILE, not with the element, and no
      // `ResizeObserver` fires for it: the box is already final while the
      // picture inside it is still unknown. Without these the overlay keeps the
      // uncropped geometry it measured before the image loaded, which is the
      // same bug one frame later.
      //
      // `resize` is the video one and is not decoration: card video is
      // `preload="none"`, so `videoWidth` stays 0 until something plays it —
      // `loadedmetadata` may be minutes away or never come. Until it does,
      // `mediaContentRect` returns the element box, which is exactly the
      // behaviour that shipped before this change rather than a new failure.
      media.addEventListener('load', measure);
      media.addEventListener('loadedmetadata', measure);
      media.addEventListener('resize', measure);

      measure();
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

    bind();

    const swaps = new MutationObserver(bind);
    swaps.observe(parent, { childList: true, subtree: true });

    return () => {
      swaps.disconnect();
      unbind();
    };
  }, [hasPlacements]);

  /**
   * What the CDN is asked for, scaled to the box the sticker is actually drawn
   * against.
   *
   * A sticker's size is a fraction of its container, and this overlay's
   * container is now the ARTWORK rect rather than the card. Under a horizontal
   * crop that rect is much wider than the card — a 16:9 image in the 7:9 card is
   * about 2.3x — so `artworkWidth` alone would under-request by the same factor
   * and upscale artwork a creator was paid for. That is the exact failure the
   * constant above was chosen to avoid, reintroduced by moving the container.
   *
   * Rounded up to whole hundreds so a card that resizes by a pixel does not mint
   * a new CDN URL per frame, and capped: a very wide crop should not fetch a
   * sticker larger than the detail view ever asks for.
   */
  const requestWidth = (() => {
    if (!box || box.width <= 0) return artworkWidth;
    const measured = ref.current?.offsetWidth ?? 0;
    if (measured <= 0) return artworkWidth;
    const scaled = artworkWidth * (box.width / measured);
    return Math.min(Math.ceil(scaled / 100) * 100, MAX_ARTWORK_WIDTH);
  })();

  // Narrows `batch` as well: `placements` is empty without one, so reaching
  // here means the provider is present.
  if (!batch || !hasPlacements) return null;

  return (
    <div
      ref={ref}
      // The hook the card templates use to make this ride whatever transform
      // they apply to the media on hover. An attribute rather than a class
      // because the two templates own different stylesheets and neither should
      // have to import a class from this component to scale it.
      data-sticker-overlay=""
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {box && (
        <div className="pointer-events-none absolute" style={box}>
          <StickerPlacementOverlay
            placements={placements}
            viewerId={currentUser?.id}
            interactive={false}
            sticker={batch?.sticker}
            artworkWidth={requestWidth}
            treatment={batch.treatment}
            surface="card"
          />
        </div>
      )}
    </div>
  );
}
