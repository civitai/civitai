import type { WornDecoration } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';
import { ImageMediaHat } from '~/components/Cosmetics/EventDecoration/EventDecorationOverlay';
import { getHatRoom } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { MEDIA_OVERLAY_ATTR, useDrawnMediaBox } from '~/components/EdgeMedia/useDrawnMediaBox';

/**
 * An image's hat on the picture itself where the media is letterboxed inside a larger slot (the
 * image detail): the slot's corner is often empty space, so the hat goes on the box the media is
 * drawn in, at the feed-card size and smaller on a narrower picture. It sits on the picture's
 * corner as in the feed, reaching out over the letterbox space; the slot clips, so on a side where
 * the picture meets the slot's edge the hat stays inside it.
 *
 * Comes after the media and BEFORE ImageStickerOverlay, inside a positioned parent: `isolate` keeps
 * the hat's own z-index inside this host, so stickers (and a sticker being placed) paint and take
 * the pointer above the hat where they overlap.
 */
export function DrawnMediaHat({
  imageId,
  decoration,
}: {
  imageId: number;
  decoration: WornDecoration;
}) {
  const { hostRef, box } = useDrawnMediaBox(!!decoration);
  if (!decoration) return null;
  return (
    <div
      ref={hostRef}
      {...{ [MEDIA_OVERLAY_ATTR]: '' }}
      data-testid="drawn-media-hat"
      className="pointer-events-none absolute inset-0 isolate"
    >
      {box && (
        <div className="pointer-events-none absolute" style={box}>
          <ImageMediaHat
            imageId={imageId}
            decoration={decoration}
            cardWidth={box.width}
            allowance={{ left: getHatRoom(box.left), top: getHatRoom(box.top) }}
          />
        </div>
      )}
    </div>
  );
}
