import { getHatPreviewBox } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { TeamHat } from '~/components/HatTurf/TeamHat';
import type { TurfHatArt as Art } from '~/server/schema/turf.schema';

const pct = (share: number) => `${share * 100}%`;

/**
 * A placed hat as a sticker: the hat cosmetic's own art in a `size` px square, its visible pixels
 * centred and scaled as the hat previews are (getHatPreviewBox), so every design reads the same size
 * and sits on its spot. Art with no fit fills most of the square. A sticker whose art is not known
 * (a push from an older server, or a cosmetic without a url) falls back to the team cone.
 */
export function TurfHatArt({
  art,
  color,
  size,
}: {
  art?: Art | null;
  color: string;
  size: number;
}) {
  if (!art) return <TeamHat color={color} size={size} />;
  const box = getHatPreviewBox({
    canvas: art.canvas ?? undefined,
    bounds: art.bounds ?? undefined,
  }) ?? { width: 0.8, height: 1, left: 0.1, top: 0 };
  return (
    <span
      style={{ position: 'relative', display: 'block', width: size, height: size }}
      data-testid="hat-turf-art"
    >
      <EdgeMedia
        src={art.url}
        type="image"
        // About twice the drawn width, for sharp art on dense screens.
        width={Math.min(256, Math.ceil(size * box.width * 2))}
        alt=""
        draggable={false}
        style={{
          position: 'absolute',
          maxWidth: 'none',
          width: pct(box.width),
          height: pct(box.height),
          left: pct(box.left),
          top: pct(box.top),
        }}
      />
    </span>
  );
}
