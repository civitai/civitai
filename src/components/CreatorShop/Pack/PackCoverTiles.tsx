import { ThemeIcon } from '@mantine/core';
import { IconPackage } from '@tabler/icons-react';
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
  fallbackIcon,
}: {
  tiles: string[];
  size?: number;
  className?: string;
  /** Render a package icon rather than nothing when there are no tiles. */
  fallbackIcon?: boolean;
}) {
  const shown = tiles.slice(0, 4);
  // Members without artwork (a NamePlate has no `url`) can leave a pack with no
  // tiles at all, which rendered an empty well on the buyer's card.
  if (!shown.length)
    return fallbackIcon ? (
      <ThemeIcon variant="light" color="gray" size={size} radius="md" className={className}>
        <IconPackage size={Math.round(size / 2)} />
      </ThemeIcon>
    ) : null;

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
