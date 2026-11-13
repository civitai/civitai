import { Slider } from '@mantine/core';
import {
  IconArrowsDiagonalMinimize2,
  IconArrowsShuffle,
  IconBookmark,
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
import { forwardRef, useCallback, useRef, useState } from 'react';
import { useAudioPeaks } from '~/components/Audio/useAudioPeaks';
import { WaveformBars } from '~/components/Audio/WaveformBars';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { Tooltip } from '~/components/MantineOverlays';
import type { MusicAccent } from '~/components/MusicPlayer/music-accent';
import { withAlpha } from '~/components/MusicPlayer/music-accent';
import { seekMusicPlayer } from '~/components/MusicPlayer/MusicPlayerAudio';
import {
  ACCENT,
  accentAt,
  dimmed,
  Equalizer,
  SongArt,
} from '~/components/MusicPlayer/MusicPlayerParts';
import { MusicUpNextPanel } from '~/components/MusicPlayer/MusicUpNextPanel';
import { useMusicPlayerCover } from '~/components/MusicPlayer/useMusicPlayerCover';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { formatPlaybackTime, playbackProgress, timeFromPointer } from '~/utils/audio-player';
import { CollectionType } from '~/shared/utils/prisma/enums';

const SEEK_STEP_SECONDS = 5;
const WAVEFORM_BARS = 100;

const iconButton =
  'flex size-9 shrink-0 items-center justify-center rounded-lg text-gray-9 transition-colors hover:bg-gray-1 dark:text-dark-0 dark:hover:bg-dark-5';

const store = useMusicPlayerStore.getState;

/**
 * The global player's bar (Pencil `KZCo9`): the last row of the site chrome while a song is in the
 * player and the view is `bar`. Its accent comes from the song's cover; without one, the Civitai
 * primary.
 */
export function MusicPlayerBar() {
  const track = useMusicPlayerStore((s) => s.current);
  const view = useMusicPlayerStore((s) => s.view);
  if (!track || view !== 'bar') return null;
  return <Bar track={track} />;
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
      className="relative z-[201] flex shrink-0 items-center gap-3.5 overflow-hidden border-t border-gray-3 bg-gray-0 px-5 dark:border-dark-4 dark:bg-dark-6"
      style={
        {
          ...(accent && { '--music-accent': accent.accent, '--music-accent-2': accent.accent2 }),
          // The last in-flow row of `#__next`: the viewport's bottom edge, as the ad bar was.
          height: 'calc(112px + var(--safe-area-inset-bottom))',
          paddingBottom: 'var(--safe-area-inset-bottom)',
        } as CSSProperties
      }
    >
      {accent && <Wash accent={accent} playing={playing} />}
      <IconButton label="Minimize player" onClick={() => store().minimize()}>
        <IconArrowsDiagonalMinimize2 size={18} />
      </IconButton>
      <Cover url={cover?.url} accent={accent} playing={playing} />
      <div className="flex w-[200px] shrink-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[19px] font-bold leading-tight text-black dark:text-white">
            {track.title || 'Untitled song'}
          </span>
          <Equalizer playing={playing} />
        </div>
        <span className={clsx('truncate text-xs', dimmed)}>
          {error ? "Couldn't play this song" : track.creator.username}
        </span>
      </div>
      <Transport playing={playing} />
      <Timeline track={track} playing={playing} />
      <Controls track={track} accent={accent} />
    </div>
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
    <div className="shrink-0 rounded-[14px]" style={{ boxShadow: glow }}>
      <SongArt url={url} width={64} iconSize={28} className="size-16 rounded-[14px]" />
    </div>
  );
}

function Transport({ playing }: { playing: boolean }) {
  const shuffle = useMusicPlayerStore((s) => s.shuffle);
  const repeat = useMusicPlayerStore((s) => s.repeat);
  const toggleColour = (on: boolean) => (on ? { color: ACCENT } : undefined);
  return (
    <div className="flex w-[200px] shrink-0 items-center justify-center gap-2.5">
      <Tooltip label="Shuffle">
        <button
          type="button"
          aria-label="Shuffle"
          aria-pressed={shuffle}
          onClick={() => store().toggleShuffle()}
          className={clsx('flex size-6 items-center justify-center', !shuffle && dimmed)}
          style={toggleColour(shuffle)}
        >
          <IconArrowsShuffle size={18} />
        </button>
      </Tooltip>
      <button
        type="button"
        aria-label="Previous"
        onClick={() => store().previous()}
        className="flex size-6 items-center justify-center text-gray-9 dark:text-dark-0"
      >
        <IconPlayerSkipBackFilled size={20} />
      </button>
      <button
        type="button"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => store().togglePlay()}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-white transition-transform hover:scale-105"
        style={{ backgroundColor: ACCENT }}
      >
        {playing ? <IconPlayerPauseFilled size={20} /> : <IconPlayerPlayFilled size={20} />}
      </button>
      <button
        type="button"
        aria-label="Next"
        onClick={() => store().next()}
        className="flex size-6 items-center justify-center text-gray-9 dark:text-dark-0"
      >
        <IconPlayerSkipForwardFilled size={20} />
      </button>
      <Tooltip label={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat'}>
        <button
          type="button"
          aria-label="Repeat"
          aria-pressed={repeat !== 'off'}
          onClick={() => store().cycleRepeat()}
          className={clsx('flex size-6 items-center justify-center', repeat === 'off' && dimmed)}
          style={toggleColour(repeat !== 'off')}
        >
          {repeat === 'one' ? <IconRepeatOnce size={18} /> : <IconRepeat size={18} />}
        </button>
      </Tooltip>
    </div>
  );
}

/** Elapsed time, waveform and length: the only part of the bar that follows the playhead. */
function Timeline({ track, playing }: { track: MusicTrack; playing: boolean }) {
  const currentTime = useMusicPlayheadStore((s) => s.currentTime);
  const duration = useMusicPlayheadStore((s) => s.duration) || track.durationSec;
  const sliderRef = useRef<HTMLDivElement>(null);
  const { url } = useEdgeUrl(track.url, { type: 'audio' });
  const peaks = useAudioPeaks(url, WAVEFORM_BARS, sliderRef);
  const progress = playbackProgress(currentTime, duration);
  const played = playing ? ACCENT : accentAt(50);

  const seekFromPointer = (e: PointerEvent<HTMLElement>) =>
    seekMusicPlayer(timeFromPointer(e.clientX, e.currentTarget.getBoundingClientRect(), duration));

  return (
    <>
      <span className={clsx('w-[34px] shrink-0 text-xs', dimmed)}>
        {formatPlaybackTime(currentTime)}
      </span>
      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label="Song progress"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}`}
        className="relative flex h-12 min-w-0 flex-1 cursor-pointer touch-none items-center"
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
        {peaks ? (
          <>
            <WaveformBars
              peaks={peaks}
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
      <span className={clsx('shrink-0 text-xs', dimmed)}>{formatPlaybackTime(duration)}</span>
    </>
  );
}

function Controls({ track, accent }: { track: MusicTrack; accent: MusicAccent | null }) {
  const muted = useMusicPlayerStore((s) => s.muted);
  const volume = useMusicPlayerStore((s) => s.volume);
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
        <Tooltip label={muted ? 'Unmute' : 'Mute'}>
          <button
            type="button"
            aria-label={muted ? 'Unmute' : 'Mute'}
            onClick={() => store().toggleMute()}
            className="flex size-6 items-center justify-center text-gray-9 dark:text-dark-0"
          >
            {muted ? <IconVolumeOff size={18} /> : <IconVolume size={18} />}
          </button>
        </Tooltip>
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
    <Tooltip label={label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={clsx(iconButton, className)}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
});
