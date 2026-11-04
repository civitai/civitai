import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { TeamHat } from '~/components/HatTurf/TeamHat';

/**
 * A placed hat as a sticker: the hat cosmetic's own art, `size` px wide. A sticker whose art is not
 * known (a push from an older server, or a cosmetic without a url) falls back to the team cone.
 */
export function TurfHatArt({
  url,
  color,
  size,
}: {
  url?: string | null;
  color: string;
  size: number;
}) {
  if (!url) return <TeamHat color={color} size={size} />;
  return (
    <EdgeMedia
      src={url}
      type="image"
      // About twice the drawn width, for sharp art on dense screens.
      width={Math.min(256, Math.ceil(size * 2))}
      alt=""
      draggable={false}
      style={{ width: size, maxWidth: 'none', height: 'auto' }}
      data-testid="hat-turf-art"
    />
  );
}
