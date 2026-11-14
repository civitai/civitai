import { Slider } from '@mantine/core';
import {
  IconArrowsDiagonalMinimize2,
  IconArrowsShuffle,
  IconBookmark,
  IconMessage,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconPlaylist,
  IconRepeat,
  IconRepeatOnce,
  IconVolume,
  IconVolumeOff,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties, PointerEvent, ReactNode } from 'react';
import { forwardRef, useCallback, useMemo, useState } from 'react';
import { resamplePeaks } from '~/components/Audio/resample-peaks';
import { useAudioPeaks } from '~/components/Audio/useAudioPeaks';
import { WaveformBars } from '~/components/Audio/WaveformBars';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { NextLink } from '~/components/NextLink/NextLink';
import type { MusicAccent } from '~/components/MusicPlayer/music-accent';
import { withAlpha } from '~/components/MusicPlayer/music-accent';
import { seekMusicPlayer } from '~/components/MusicPlayer/MusicPlayerAudio';
import {
  MUSIC_PLAYER_BAR_HEIGHT,
  MUSIC_PLAYER_Z_INDEX,
  PlayerTooltip,
} from '~/components/MusicPlayer/MusicPlayerLayers';
import {
  ACCENT,
  accentAt,
  dimmed,
  Equalizer,
  SongArt,
  songCreatorHref,
} from '~/components/MusicPlayer/MusicPlayerParts';
import {
  TimedCommentStrip,
  usePlayerTimedComments,
} from '~/components/MusicPlayer/MusicPlayerTimedComments';
import { MusicUpNextPanel } from '~/components/MusicPlayer/MusicUpNextPanel';
import { useMusicPlayerCover } from '~/components/MusicPlayer/useMusicPlayerCover';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { formatPlaybackTime, playbackProgress, timeFromPointer } from '~/utils/audio-player';
import { CollectionType } from '~/shared/utils/prisma/enums';

const SEEK_STEP_SECONDS = 5;
// Decoded once at this resolution, then shown as one bar per WAVEFORM_BAR_PITCH px of the timeline,
// so a wide screen gets more bars rather than the same bars spread thin.
const WAVEFORM_PEAKS = 400;
const WAVEFORM_BAR_PITCH = 6;
const WAVEFORM_MIN_BARS = 40;
// The waveform decode downloads the whole song: wait until it has played this long, so skipping
// through songs costs nothing.
const WAVEFORM_AFTER_LISTENED_SEC = 1;

const hoverSurface = 'transition-colors hover:bg-gray-1 dark:hover:bg-dark-5';
const iconButton = clsx(
  'flex size-9 shrink-0 items-center justify-center rounded-lg text-gray-9 dark:text-dark-0',
  hoverSurface
);
// The transport's and the volume's small icon buttons: the 36px buttons' hover, in 28px.
const smallIconButton = clsx(
  'flex size-7 shrink-0 items-center justify-center rounded-md',
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
 * The bar below the `sm` breakpoint (Pencil `Pf8Oy`): cover, song, play/pause and close over the
 * cover's colours. The close button is not in the frame: a phone has no other way to dismiss it.
 */
function CompactBar({ track }: { track: MusicTrack }) {
  const playing = useMusicPlayerStore((s) => s.playing);
  const error = useMusicPlayerStore((s) => s.error);
  const { cover, accent } = useMusicPlayerCover(track.id);
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
          ...(accent && {
            '--music-accent': accent.accent,
            '--music-accent-2': accent.accent2,
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
        <SongDetailLink track={track} className="shrink-0">
          <SongArt url={cover?.url} width={40} iconSize={20} className="size-10 rounded-lg" />
        </SongDetailLink>
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <SongDetailLink
            track={track}
            className={clsx(
              'truncate text-sm font-bold leading-tight',
              onColour ? 'text-white' : 'text-black dark:text-white'
            )}
          >
            {track.title || 'Untitled song'}
          </SongDetailLink>
          <CreatorLine
            track={track}
            error={error}
            className={clsx('text-xs font-semibold', onColour ? 'text-white/90' : dimmed)}
          />
        </div>
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => store().togglePlay()}
          className={clsx(
            'flex size-[38px] shrink-0 items-center justify-center rounded-full',
            onColour ? 'bg-white text-[#1A1B1E]' : 'text-white'
          )}
          style={onColour ? undefined : { backgroundColor: ACCENT }}
        >
          {playing ? <IconPlayerPauseFilled size={18} /> : <IconPlayerPlayFilled size={18} />}
        </button>
        <button
          type="button"
          aria-label="Close player"
          onClick={() => store().close()}
          className={clsx(
            'flex size-9 shrink-0 items-center justify-center rounded-lg',
            onColour ? 'text-white' : 'text-gray-9 dark:text-dark-0'
          )}
        >
          <IconX size={18} />
        </button>
      </div>
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
          backgroundColor: onColour ? '#fff' : ACCENT,
        }}
      />
    </div>
  );
}

function Bar({ track }: { track: MusicTrack }) {
  const playing = useMusicPlayerStore((s) => s.playing);
  const error = useMusicPlayerStore((s) => s.error);
  const { cover, accent } = useMusicPlayerCover(track.id);

  return (
    <div
      data-music-player-bar=""
      role="region"
      aria-label="Music player"
      className="relative flex shrink-0 items-center gap-3.5 overflow-hidden border-t border-gray-3 bg-gray-0 px-5 dark:border-dark-4 dark:bg-dark-6"
      style={
        {
          ...(accent && { '--music-accent': accent.accent, '--music-accent-2': accent.accent2 }),
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
        <div className="flex min-w-0 items-center gap-2">
          <SongDetailLink
            track={track}
            className="truncate text-[15px] font-bold leading-tight text-black dark:text-white"
          >
            {track.title || 'Untitled song'}
          </SongDetailLink>
          <Equalizer playing={playing} />
        </div>
        <CreatorLine track={track} error={error} className={clsx('text-xs', dimmed)} />
      </div>
      <Transport playing={playing} />
      <Timeline track={track} playing={playing} />
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

function Transport({ playing }: { playing: boolean }) {
  const shuffle = useMusicPlayerStore((s) => s.shuffle);
  const repeat = useMusicPlayerStore((s) => s.repeat);
  const toggleColour = (on: boolean) => (on ? { color: ACCENT } : undefined);
  return (
    <div className="flex w-[200px] shrink-0 items-center justify-center gap-2.5">
      <PlayerTooltip label="Shuffle">
        <button
          type="button"
          aria-label="Shuffle"
          aria-pressed={shuffle}
          onClick={() => store().toggleShuffle()}
          className={clsx(smallIconButton, !shuffle && dimmed)}
          style={toggleColour(shuffle)}
        >
          <IconArrowsShuffle size={18} />
        </button>
      </PlayerTooltip>
      <button
        type="button"
        aria-label="Previous"
        onClick={() => store().previous()}
        className={clsx(smallIconButton, 'text-gray-9 dark:text-dark-0')}
      >
        <IconPlayerSkipBackFilled size={20} />
      </button>
      <PlayerTooltip label={playing ? 'Pause' : 'Play'}>
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => store().togglePlay()}
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-white transition-transform hover:scale-105"
          style={{ backgroundColor: ACCENT }}
        >
          {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
        </button>
      </PlayerTooltip>
      <button
        type="button"
        aria-label="Next"
        onClick={() => store().next()}
        className={clsx(smallIconButton, 'text-gray-9 dark:text-dark-0')}
      >
        <IconPlayerSkipForwardFilled size={20} />
      </button>
      <PlayerTooltip
        label={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat'}
      >
        <button
          type="button"
          aria-label="Repeat"
          aria-pressed={repeat !== 'off'}
          onClick={() => store().cycleRepeat()}
          className={clsx(smallIconButton, repeat === 'off' && dimmed)}
          style={toggleColour(repeat !== 'off')}
        >
          {repeat === 'one' ? <IconRepeatOnce size={18} /> : <IconRepeat size={18} />}
        </button>
      </PlayerTooltip>
    </div>
  );
}

/** Elapsed time, waveform and length: the only part of the bar that follows the playhead. */
function Timeline({ track, playing }: { track: MusicTrack; playing: boolean }) {
  const currentTime = useMusicPlayheadStore((s) => s.currentTime);
  const duration = useMusicPlayheadStore((s) => s.duration) || track.durationSec;
  const [barCount, setBarCount] = useState(100);
  const sliderRef = useResizeObserver<HTMLDivElement>((entry) =>
    setBarCount(
      Math.max(WAVEFORM_MIN_BARS, Math.floor(entry.contentRect.width / WAVEFORM_BAR_PITCH))
    )
  );
  const { url } = useEdgeUrl(track.url, { type: 'audio' });
  const listened = useMusicPlayerStore(
    (s) => (s.playback?.listenedSec ?? 0) >= WAVEFORM_AFTER_LISTENED_SEC
  );
  const peaks = useAudioPeaks(url, WAVEFORM_PEAKS, sliderRef, { enabled: listened });
  const bars = useMemo(() => (peaks ? resamplePeaks(peaks, barCount) : null), [peaks, barCount]);
  const progress = playbackProgress(currentTime, duration);
  const played = playing ? ACCENT : accentAt(50);
  const timedComments = usePlayerTimedComments(track.id);
  const withStrip = timedComments.length > 0;

  const seekFromPointer = (e: PointerEvent<HTMLElement>) =>
    seekMusicPlayer(timeFromPointer(e.clientX, e.currentTarget.getBoundingClientRect(), duration));

  return (
    <>
      <span className={clsx('w-[34px] shrink-0 text-xs', dimmed)}>
        {formatPlaybackTime(currentTime)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        {withStrip && (
          <TimedCommentStrip
            comments={timedComments}
            duration={duration}
            currentTime={currentTime}
          />
        )}
        <div
          ref={sliderRef}
          role="slider"
          tabIndex={0}
          aria-label="Song progress"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(currentTime)}
          aria-valuetext={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}`}
          className={clsx(
            'relative flex w-full min-w-0 cursor-pointer touch-none items-center',
            withStrip ? 'h-10' : 'h-12'
          )}
          style={{ '--waveform-played': played } as CSSProperties}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            seekFromPointer(e);
          }}
          onPointerMove={(e) => {
            if (e.buttons === 1) seekFromPointer(e);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') seekMusicPlayer(currentTime + SEEK_STEP_SECONDS);
            else if (e.key === 'ArrowLeft') seekMusicPlayer(currentTime - SEEK_STEP_SECONDS);
            else return;
            e.preventDefault();
          }}
        >
          {bars ? (
            <>
              <WaveformBars
                peaks={bars}
                progress={progress}
                className="justify-between"
                barClassName="min-w-px max-w-[3px] flex-1 rounded-[2px]"
                unplayedClassName="bg-gray-4 dark:bg-dark-3"
              />
              <div
                aria-hidden
                className="absolute inset-y-0 w-0.5 bg-black dark:bg-white"
                style={{ left: `${progress * 100}%` }}
              />
            </>
          ) : (
            <div className="h-1 w-full overflow-hidden rounded-full bg-gray-4 dark:bg-dark-3">
              <div
                className="h-full"
                style={{ width: `${progress * 100}%`, backgroundColor: played }}
              />
            </div>
          )}
        </div>
      </div>
      <span className={clsx('shrink-0 text-xs', dimmed)}>{formatPlaybackTime(duration)}</span>
    </>
  );
}

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
            openAddToCollectionModal({ props: { imageId: track.id, type: CollectionType.Image } })
          }
        >
          <IconBookmark size={18} />
        </IconButton>
      </LoginRedirect>
      <IconButton
        label={showTimedComments ? 'Hide timed comments' : 'Show timed comments'}
        aria-pressed={showTimedComments}
        onClick={() => store().toggleTimedComments()}
        style={showTimedComments ? { backgroundColor: accentAt(15), color: ACCENT } : undefined}
      >
        <IconMessage size={18} />
      </IconButton>
      <IconButton
        ref={setUpNextButton}
        label="Up next"
        aria-expanded={upNextOpen}
        onClick={() => setUpNextOpen((open) => !open)}
        style={upNextOpen ? { backgroundColor: accentAt(15), color: ACCENT } : undefined}
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
            bar: { backgroundColor: ACCENT },
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
