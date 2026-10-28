import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WornDecoration } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';
import { ImageMediaHat } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';
import { getHatRoom } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { MEDIA_OVERLAY_ATTR, useDrawnMediaBox } from '~/components/EdgeMedia/useDrawnMediaBox';

/** The image detail's header leaves 12px free above the slot; the slot's left edge is the window's. */
const SLOT_BLEED = { left: 0, top: 12 };

/**
 * An image's hat on the box its picture is drawn in, portalled into `layer` because the carousel
 * clips what it draws. An empty host stays in the slide, marked as a media overlay so the sticker
 * overlay still finds the picture. Nothing is drawn without a `layer` or while `hidden`.
 */
export function DrawnMediaHat({
  imageId,
  decoration,
  layer,
  hidden = false,
}: {
  imageId: number;
  decoration: WornDecoration;
  layer: HTMLElement | null;
  hidden?: boolean;
}) {
  const { hostRef, box } = useDrawnMediaBox(!!decoration && !!layer);
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);

  // The host's place in the layer: it moves with the slide, which the box does not see.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!layer || !host || !box || hidden) {
      setOrigin(null);
      return;
    }
    const measure = () => {
      const at = host.getBoundingClientRect();
      const around = layer.getBoundingClientRect();
      const next = { x: at.left - around.left, y: at.top - around.top };
      setOrigin((current) => (current?.x === next.x && current?.y === next.y ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    observer.observe(host);
    return () => observer.disconnect();
  }, [layer, box, hidden, hostRef]);

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
                left: getHatRoom(box.left + SLOT_BLEED.left),
                top: getHatRoom(box.top + SLOT_BLEED.top),
              }}
            />
          </div>,
          layer
        )}
    </>
  );
}
