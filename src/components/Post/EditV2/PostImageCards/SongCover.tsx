import { IconMusic } from '@tabler/icons-react';
import clsx from 'clsx';

/** Stands in for a song's cover wherever the post editor would show an image. */
export function SongGlyphTile({ className }: { className?: string }) {
  return (
    <div
      data-testid="song-tile"
      className={clsx(
        'flex shrink-0 items-center justify-center rounded-xl bg-gray-2 text-gray-6 dark:bg-dark-6 dark:text-dark-2',
        className
      )}
    >
      <IconMusic size={64} stroke={1.5} />
    </div>
  );
}

/** The cover tile of a song in the post editor. */
export function SongCover() {
  return <SongGlyphTile className="aspect-square w-full" />;
}
