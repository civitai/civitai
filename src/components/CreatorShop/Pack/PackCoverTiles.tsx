import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

/**
 * A pack with no cover of its own renders its contents instead.
 *
 * Tiles come from `meta.coverTiles`, snapshotted when the pack is built, so a
 * storefront card can draw this without joining the members.
 */
export function PackCoverTiles({
  tiles,
  size = 256,
  className,
}: {
  tiles: string[];
  size?: number;
  className?: string;
}) {
  const shown = tiles.slice(0, 4);
  if (!shown.length) return null;

  // One member fills the frame; two or more share a 2x2 grid, so a three-member
  // pack reads as a pack rather than as a slightly-off single item.
  const single = shown.length === 1;

  return (
    <div
      className={clsx('grid gap-1', single ? 'grid-cols-1' : 'grid-cols-2', className)}
      style={{ width: size, height: size }}
    >
      {shown.map((url, index) => (
        <div key={`${url}-${index}`} className="flex items-center justify-center overflow-hidden">
          <EdgeMedia
            src={url}
            width={single ? size : Math.floor(size / 2)}
            alt=""
            className="max-h-full max-w-full object-contain"
          />
        </div>
      ))}
    </div>
  );
}
