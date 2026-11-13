import { IconMusic } from '@tabler/icons-react';
import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import styles from './MusicPlayerBar.module.scss';

/** The global player's accent: the artwork's colour, set on the player root, else the Civitai primary. */
export const ACCENT = 'var(--music-accent, var(--mantine-primary-color-filled))';
export const accentAt = (percent: number) =>
  `color-mix(in srgb, ${ACCENT} ${percent}%, transparent)`;

export const dimmed = 'text-gray-6 dark:text-dark-2';

// Pencil `VKZHS`: playing and paused bar heights.
const EQ_HEIGHTS = { playing: [10, 16, 7, 13], paused: [6, 10, 5, 8] };

export function Equalizer({ playing }: { playing: boolean }) {
  const heights = playing ? EQ_HEIGHTS.playing : EQ_HEIGHTS.paused;
  return (
    <span aria-hidden className="flex h-4 shrink-0 items-end gap-0.5">
      {heights.map((height, i) => (
        <span
          key={i}
          className={clsx('w-[3px] rounded-[1px]', styles.eqBar, playing && styles.eqPlaying)}
          style={{ height, backgroundColor: playing ? ACCENT : accentAt(50) }}
        />
      ))}
    </span>
  );
}

/** A song's cover, or the music placeholder when it has none the viewer may see. */
export function SongArt({
  url,
  width,
  iconSize,
  className,
}: {
  url?: string;
  /** The rendered width, for the image request. */
  width: number;
  iconSize: number;
  className?: string;
}) {
  return (
    <div className={clsx('shrink-0 overflow-hidden bg-gray-2 dark:bg-dark-5', className)}>
      {url ? (
        <EdgeMedia
          src={url}
          type="image"
          width={width * 2}
          name="Song cover"
          className="size-full object-cover"
          wrapperProps={{ className: 'size-full' }}
        />
      ) : (
        <div
          data-testid="music-cover-placeholder"
          className={clsx('flex size-full items-center justify-center', dimmed)}
        >
          <IconMusic size={iconSize} stroke={1.5} />
        </div>
      )}
    </div>
  );
}
