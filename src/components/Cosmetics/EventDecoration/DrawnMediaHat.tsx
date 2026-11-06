import type { EmblaCarouselType } from 'embla-carousel';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WornDecoration } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';
import { ImageMediaHat } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';
import {
  HAT_ALLOWANCE,
  getHatRoom,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { MEDIA_OVERLAY_ATTR, useDrawnMediaBox } from '~/components/EdgeMedia/useDrawnMediaBox';

/**
 * An image's hat on the box its picture is drawn in, portalled into `layer` because the carousel
 * clips what it draws. An empty host stays in the slide, marked as a media overlay so the sticker
 * overlay still finds the picture. Nothing is drawn without a `layer`. While `embla` moves its
 * slides, the hat's place is read on each frame and written straight to its element, so it rides
 * its picture. At rest nothing is read: embla emits nothing.
 */
export function DrawnMediaHat({
  imageId,
  decoration,
  layer,
  embla,
}: {
  imageId: number;
  decoration: WornDecoration;
  layer: HTMLElement | null;
  embla?: EmblaCarouselType | null;
}) {
  const { hostRef, box } = useDrawnMediaBox(!!decoration && !!layer);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // The host's place in the layer: it moves with the slide, which the box does not see.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!layer || !host || !box) {
      setOrigin(null);
      return;
    }
    // A picture slid out of the layer, or not yet in, wears no hat until its left edge is in view.
    const read = () => {
      const at = host.getBoundingClientRect();
      const around = layer.getBoundingClientRect();
      const x = at.left - around.left;
      const pictureLeft = x + box.left;
      return pictureLeft >= -1 && pictureLeft < around.width ? { x, y: at.top - around.top } : null;
    };
    const measure = () => {
      const next = read();
      setOrigin((current) =>
        current === next || (current && next && current.x === next.x && current.y === next.y)
          ? current
          : next
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    observer.observe(host);
    // Embla moves the slides before it emits `scroll`, so the host is read where it is drawn.
    const follow = (settled: boolean) => {
      const el = boxRef.current;
      const next = read();
      if (next && el) {
        el.style.left = `${next.x + box.left}px`;
        el.style.top = `${next.y + box.top}px`;
      }
      // Mounts or unmounts the hat as its picture enters or leaves the view, and brings React's copy
      // of the place up to date once the slide stops.
      if (settled || !!next !== !!el) measure();
    };
    const onScroll = () => follow(false);
    const onSettle = () => follow(true);
    embla?.on('scroll', onScroll).on('settle', onSettle);
    return () => {
      embla?.off('scroll', onScroll).off('settle', onSettle);
      observer.disconnect();
    };
  }, [layer, box, embla, hostRef]);

  if (!decoration || !layer) return null;
  return (
    <>
      <div
        ref={hostRef}
        {...{ [MEDIA_OVERLAY_ATTR]: '' }}
        data-testid="drawn-media-hat"
        className="pointer-events-none absolute inset-0"
      />
      {box &&
        origin &&
        createPortal(
          <div
            ref={boxRef}
            data-testid="drawn-media-hat-box"
            className="pointer-events-none absolute"
            style={{
              left: origin.x + box.left,
              top: origin.y + box.top,
              width: box.width,
              height: box.height,
            }}
          >
            <ImageMediaHat
              imageId={imageId}
              decoration={decoration}
              cardWidth={box.width}
              allowance={{
                // The carousel starts at the window's edge, so beside the picture the hat reaches only as
                // far as the letterbox. Above it, the hat takes a feed card's reach even where it covers
                // the header's buttons: it takes the pointer only in its own outline.
                left: getHatRoom(box.left),
                top: HAT_ALLOWANCE.corner,
              }}
            />
          </div>,
          layer
        )}
    </>
  );
}
