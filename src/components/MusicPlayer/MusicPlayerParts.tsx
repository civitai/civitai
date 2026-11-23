import { IconMusic } from '@tabler/icons-react';
import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import styles from './MusicPlayerBar.module.scss';

/** The global player's accent: the artwork's colour, set on the player root, else the Civitai primary. */
export const ACCENT = 'var(--music-accent, var(--mantine-primary-color-filled))';
export const accentAt = (percent: number) =>
  `color-mix(in srgb, ${ACCENT} ${percent}%, transparent)`;

// Secondary text (times, creator names) at WCAG AA on every player surface: gray-7 on the light
// ones (gray-6 was 3.2:1), dark-1 on the dark ones (dark-2 was 4.25:1 on the Up next panel's dark-5).
export const dimmed = 'text-gray-7 dark:text-dark-1';

/** Where a song's creator name leads: the music tab of their profile. */
export const songCreatorHref = (username: string) => `/user/${username}/music`;

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
  gradient,
}: {
  url?: string;
  /** The rendered width, for the image request. */
  width: number;
  iconSize: number;
  className?: string;
  /** No cover: the design's gradient tile (Pencil `AECSM`) rather than the plain grey one. */
  gradient?: boolean;
}) {
  return (
    <div
      className={clsx(
        'shrink-0 overflow-hidden',
        !url && gradient
          ? 'bg-gradient-to-br from-[#5f3dc4] to-[#4dabf7]'
          : 'bg-gray-2 dark:bg-dark-5',
        className
      )}
    >
      {url ? (
        <EdgeMedia
          src={url}
          type="image"
          width={width * 2}
          name="Song cover"
          className="size-full object-cover"
          // `width` only sizes the request; EdgeImage's inline maxWidth would stop the cover short of a wider box.
          style={{ maxWidth: 'none' }}
        />
      ) : (
        <div
          data-testid="music-cover-placeholder"
          className={clsx(
            'flex size-full items-center justify-center',
            gradient ? 'text-white/80' : dimmed
          )}
        >
          <IconMusic size={iconSize} stroke={1.5} />
        </div>
      )}
    </div>
  );
}
