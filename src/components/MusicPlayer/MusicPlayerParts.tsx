import { IconMusic } from '@tabler/icons-react';
import clsx from 'clsx';
import { useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ACCENT_FILL } from '~/components/MusicPlayer/music-accent';
import styles from './MusicPlayerBar.module.scss';

/** `ACCENT_FILL` at `percent`% opacity, for tints and glows. */
export const accentAt = (percent: number) =>
  `color-mix(in srgb, ${ACCENT_FILL} ${percent}%, transparent)`;

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
          style={{ height, backgroundColor: playing ? ACCENT_FILL : accentAt(50) }}
        />
      ))}
    </span>
  );
}

/**
 * The cover url to render, or none once it failed to load. A replaced cover's file is deleted, so a
 * cover list read before the replacement can name a cover that no longer loads; a new url is tried.
 */
export function useLoadableCover(url: string | undefined) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const shown = url && url !== failedUrl ? url : undefined;
  return { shown, onError: () => setFailedUrl(shown) };
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
  const { shown, onError } = useLoadableCover(url);
  return (
    <div
      className={clsx(
        'shrink-0 overflow-hidden',
        !shown && gradient
          ? 'bg-gradient-to-br from-[#5f3dc4] to-[#4dabf7]'
          : 'bg-gray-2 dark:bg-dark-5',
        className
      )}
    >
      {shown ? (
        <EdgeMedia
          src={shown}
          onError={onError}
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
