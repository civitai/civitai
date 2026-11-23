import { Slider } from '@mantine/core';
import {
  IconArrowsDiagonalMinimize2,
  IconBookmark,
  IconMessage,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlaylist,
  IconVolume,
  IconVolumeOff,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { forwardRef, useCallback, useState } from 'react';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink } from '~/components/NextLink/NextLink';
import type { MusicAccent } from '~/components/MusicPlayer/music-accent';
import {
  ACCENT_FILL,
  ACCENT_TEXT,
  musicAccentVars,
  musicSurface,
  surfaceTint,
  withAlpha,
} from '~/components/MusicPlayer/music-accent';
import {
  MUSIC_PLAYER_BAR_HEIGHT,
  MUSIC_PLAYER_Z_INDEX,
  PlayerTooltip,
} from '~/components/MusicPlayer/MusicPlayerLayers';
import { dimmed, SongArt, songCreatorHref } from '~/components/MusicPlayer/MusicPlayerParts';
import { MusicNowPlayingSheet } from '~/components/MusicPlayer/MusicNowPlayingSheet';
import {
  hoverSurface,
  smallIconButton,
  Timeline,
  Transport,
} from '~/components/MusicPlayer/MusicPlayerTransport';
import { MusicUpNextPanel } from '~/components/MusicPlayer/MusicUpNextPanel';
import { useMusicPlayerCover } from '~/components/MusicPlayer/useMusicPlayerCover';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { playbackProgress } from '~/utils/audio-player';
import { CollectionType } from '~/shared/utils/prisma/enums';

const iconButton = clsx(
  'flex size-9 shrink-0 items-center justify-center rounded-lg text-gray-9 dark:text-dark-0',
  hoverSurface
);

const store = useMusicPlayerStore.getState;

/**
 * The global player's bar (Pencil `KZCo9`): the last row of the site chrome while a song is in the
 * player and the view is `bar`. Its accent comes from the song's cover; without one, the Civitai
 * primary.
 */
export function MusicPlayerBar() {
  const track = useMusicPlayerStore((s) => s.current);
  const view = useMusicPlayerStore((s) => s.view);
  const compact = useIsMobile({ type: 'media' });
  if (!track || view !== 'bar') return null;
  return compact ? <CompactBar track={track} /> : <Bar track={track} />;
}

/**
 * The mini bar on a phone (Pencil `b7MfU`): cover, song, comments and play/pause over the cover's
 * colours. Tapping the song opens the now-playing sheet, where shuffle, repeat, Up next, the timed
 * comments and closing the player are; the bar shows no timed comments of its own.
 */
function CompactBar({ track }: { track: MusicTrack }) {
  const playing = useMusicPlayerStore((s) => s.playing);
  const error = useMusicPlayerStore((s) => s.error);
  const { cover, accent } = useMusicPlayerCover(track.id);
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  // Without an accent the bar keeps the site's surface and text colours.
  const onColour = !!accent;

  return (
    <div
      data-music-player-bar=""
      role="region"
      aria-label="Music player"
      className={clsx(
        'relative flex shrink-0 flex-col overflow-hidden',
        !onColour && 'border-t border-gray-3 bg-gray-0 dark:border-dark-4 dark:bg-dark-6'
      )}
      style={
        {
          ...musicAccentVars(accent),
          ...(accent && {
            background: `linear-gradient(#14151740, #14151740), linear-gradient(90deg, ${accent.accent2}, ${accent.accent})`,
          }),
          zIndex: MUSIC_PLAYER_Z_INDEX,
          height: 'calc(62px + var(--safe-area-inset-bottom))',
          paddingBottom: 'var(--safe-area-inset-bottom)',
        } as CSSProperties
      }
    >
      <CompactProgress track={track} onColour={onColour} />
      <div className="flex min-h-0 min-w-0 flex-1 items-center gap-3 px-4">
        <button
          type="button"
          aria-label="Open now playing"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <SongArt url={cover?.url} width={40} iconSize={20} className="size-10 rounded-lg" />
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span
              className={clsx(
                'truncate text-sm font-bold leading-tight',
                onColour ? 'text-white' : 'text-black dark:text-white'
              )}
            >
              {track.title || 'Untitled song'}
            </span>
            <span
              className={clsx(
                'truncate text-xs font-semibold',
                onColour ? 'text-white/90' : dimmed
              )}
            >
              {error ? "Couldn't play this song" : track.creator.username}
            </span>
          </span>
        </button>
        <RoutedDialogLink
          name="imageDetail"
          state={{ imageId: track.id }}
          aria-label="Comments"
          className={clsx(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            onColour ? 'text-white' : 'text-gray-9 dark:text-dark-0'
          )}
        >
          <IconMessage size={20} />
        </RoutedDialogLink>
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => store().togglePlay()}
          className={clsx(
            'flex size-[38px] shrink-0 items-center justify-center rounded-full',
            onColour ? 'bg-white text-[#1A1B1E]' : 'text-white'
          )}
          style={onColour ? undefined : { backgroundColor: ACCENT_FILL }}
        >
          {playing ? <IconPlayerPauseFilled size={18} /> : <IconPlayerPlayFilled size={18} />}
        </button>
      </div>
      <MusicNowPlayingSheet
        track={track}
        accent={accent}
        coverUrl={cover?.url}
        opened={sheetOpen}
        onClose={closeSheet}
      />
    </div>
  );
}

/** The 3px progress line on top of the compact bar. */
function CompactProgress({ track, onColour }: { track: MusicTrack; onColour: boolean }) {
  const currentTime = useMusicPlayheadStore((s) => s.currentTime);
  const duration = useMusicPlayheadStore((s) => s.duration) || track.durationSec;
  return (
    <div
      aria-hidden
      className={clsx(
        'h-[3px] w-full shrink-0',
        onColour ? 'bg-white/20' : 'bg-gray-4 dark:bg-dark-3'
      )}
    >
      <div
        className="h-full"
        style={{
          width: `${playbackProgress(currentTime, duration) * 100}%`,
          backgroundColor: onColour ? '#fff' : ACCENT_FILL,
        }}
      />
    </div>
  );
}

function Bar({ track }: { track: MusicTrack }) {
  const playing = useMusicPlayerStore((s) => s.playing);
  const error = useMusicPlayerStore((s) => s.error);
  const { cover, accent } = useMusicPlayerCover(track.id);
  const surface = musicSurface(accent, 'bar');

  return (
    <div
      data-music-player-bar=""
      role="region"
      aria-label="Music player"
      className={clsx(
        'relative flex shrink-0 items-center gap-3.5 overflow-hidden border-t border-gray-3 bg-gray-0 px-5 dark:border-dark-4 dark:bg-dark-6',
        surface.className
      )}
      style={
        {
          ...surface.style,
          zIndex: MUSIC_PLAYER_Z_INDEX,
          // The last in-flow row of `#__next`: the viewport's bottom edge, as the ad bar was.
          height: `calc(${MUSIC_PLAYER_BAR_HEIGHT}px + var(--safe-area-inset-bottom))`,
          paddingBottom: 'var(--safe-area-inset-bottom)',
        } as CSSProperties
      }
    >
      {accent && <Wash accent={accent} playing={playing} />}
      <IconButton label="Minimize player" onClick={() => store().minimize()}>
        <IconArrowsDiagonalMinimize2 size={18} />
      </IconButton>
      <SongDetailLink track={track} className="shrink-0">
        <Cover url={cover?.url} accent={accent} playing={playing} />
      </SongDetailLink>
      <div className="flex w-[200px] shrink-0 flex-col gap-0.5">
        <SongDetailLink
          track={track}
          className="truncate text-[15px] font-bold leading-tight text-black dark:text-white"
        >
          {track.title || 'Untitled song'}
        </SongDetailLink>
        <CreatorLine track={track} error={error} className={clsx('text-xs', dimmed)} />
      </div>
      <Transport playing={playing} />
      <Timeline track={track} playing={playing} accent={accent} />
      <Controls track={track} accent={accent} />
    </div>
  );
}

/** The song's cover or title: opens the song's detail view. */
function SongDetailLink({
  track,
  className,
  children,
}: {
  track: MusicTrack;
  className?: string;
  children: ReactNode;
}) {
  return (
    <RoutedDialogLink
      name="imageDetail"
      state={{ imageId: track.id }}
      className={clsx('hover:underline', className)}
    >
      {children}
    </RoutedDialogLink>
  );
}

/** The creator's name, linking to their profile, or the playback error in its place. */
function CreatorLine({
  track,
  error,
  className,
}: {
  track: MusicTrack;
  error: boolean;
  className: string;
}) {
  if (error)
    return <span className={clsx('truncate', className)}>Couldn&apos;t play this song</span>;
  return (
    <NextLink
      href={songCreatorHref(track.creator.username)}
      className={clsx('truncate hover:underline', className)}
    >
      {track.creator.username}
    </NextLink>
  );
}

/** Pencil `jMD98`: a left-anchored wash of the accent, quieter while paused. */
function Wash({ accent, playing }: { accent: MusicAccent; playing: boolean }) {
  const [first, second] = playing ? [0.44, 0.11] : [0.16, 0.05];
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-[700px] max-w-full"
      style={{
        background: `linear-gradient(90deg, ${withAlpha(accent.accent, first)} 0%, ${withAlpha(
          accent.accent2,
          second
        )} 60%, ${withAlpha(accent.accent2, 0)} 100%)`,
      }}
    />
  );
}

function Cover({
  url,
  accent,
  playing,
}: {
  url?: string;
  accent: MusicAccent | null;
  playing: boolean;
}) {
  const glow = accent
    ? playing
      ? `0 4px 28px ${withAlpha(accent.accent, 0.6)}`
      : `0 4px 14px ${withAlpha(accent.accent, 0.2)}`
    : undefined;
  return (
    <div className="shrink-0 rounded-xl" style={{ boxShadow: glow }}>
      <SongArt url={url} width={48} iconSize={22} className="size-12 rounded-xl" />
    </div>
  );
}

const toggledOn = { backgroundColor: surfaceTint('bar', 'toggleOn'), color: ACCENT_TEXT };

function Controls({ track, accent }: { track: MusicTrack; accent: MusicAccent | null }) {
  const muted = useMusicPlayerStore((s) => s.muted);
  const volume = useMusicPlayerStore((s) => s.volume);
  const showTimedComments = useMusicPlayerStore((s) => s.showTimedComments);
  const [upNextOpen, setUpNextOpen] = useState(false);
  const [upNextButton, setUpNextButton] = useState<HTMLButtonElement | null>(null);
  const closeUpNext = useCallback(() => setUpNextOpen(false), []);

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <LoginRedirect reason="add-to-collection">
        <IconButton
          label="Save"
          onClick={() =>
            openAddToCollectionModal({ props: { imageId: track.id, type: CollectionType.Music } })
          }
        >
          <IconBookmark size={18} />
        </IconButton>
      </LoginRedirect>
      <IconButton
        label={showTimedComments ? 'Hide timed comments' : 'Show timed comments'}
        aria-pressed={showTimedComments}
        onClick={() => store().toggleTimedComments()}
        style={showTimedComments ? toggledOn : undefined}
      >
        <IconMessage size={18} />
      </IconButton>
      <IconButton
        ref={setUpNextButton}
        label="Up next"
        aria-expanded={upNextOpen}
        onClick={() => setUpNextOpen((open) => !open)}
        style={upNextOpen ? toggledOn : undefined}
      >
        <IconPlaylist size={18} />
      </IconButton>
      {upNextOpen && (
        <MusicUpNextPanel
          current={track}
          accent={accent}
          onClose={closeUpNext}
          // The bar is the panel's anchor: using its controls keeps the panel open.
          ignore={upNextButton?.closest<HTMLElement>('[data-music-player-bar]') ?? null}
        />
      )}
      <div className="flex items-center gap-2 px-1.5">
        <PlayerTooltip label={muted ? 'Unmute' : 'Mute'}>
          <button
            type="button"
            aria-label={muted ? 'Unmute' : 'Mute'}
            onClick={() => store().toggleMute()}
            className={clsx(smallIconButton, 'text-gray-9 dark:text-dark-0')}
          >
            {muted ? <IconVolumeOff size={18} /> : <IconVolume size={18} />}
          </button>
        </PlayerTooltip>
        <Slider
          w={56}
          className="[--slider-track-bg:theme(colors.gray.4)] dark:[--slider-track-bg:theme(colors.dark.3)]"
          size={4}
          thumbSize={10}
          min={0}
          max={100}
          label={null}
          thumbLabel="Volume"
          value={muted ? 0 : Math.round(volume * 100)}
          onChange={(value) => {
            store().setVolume(value / 100);
            if (muted && value > 0) store().toggleMute();
          }}
          styles={{
            bar: { backgroundColor: ACCENT_FILL },
            thumb: { backgroundColor: '#fff', borderWidth: 0 },
          }}
        />
      </div>
      <IconButton label="Close player" onClick={() => store().close()}>
        <IconX size={18} />
      </IconButton>
    </div>
  );
}

type IconButtonProps = {
  label: string;
  children: ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

/** A 36×36 icon button with its name as label and tooltip. */
const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, className, ...props },
  ref
) {
  return (
    <PlayerTooltip label={label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={clsx(iconButton, className)}
        {...props}
      >
        {children}
      </button>
    </PlayerTooltip>
  );
});
