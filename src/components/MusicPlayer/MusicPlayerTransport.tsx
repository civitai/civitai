import {
  IconArrowsShuffle,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerSkipBackFilled,
  IconPlayerSkipForwardFilled,
  IconRepeat,
  IconRepeatOnce,
} from '@tabler/icons-react';
import clsx from 'clsx';
import type { CSSProperties, PointerEvent } from 'react';
import { useMemo, useState } from 'react';
import { resamplePeaks } from '~/components/Audio/resample-peaks';
import { useAudioPeaks } from '~/components/Audio/useAudioPeaks';
import { WaveformBars } from '~/components/Audio/WaveformBars';
import type { MusicAccent } from '~/components/MusicPlayer/music-accent';
import { seekMusicPlayer } from '~/components/MusicPlayer/MusicPlayerAudio';
import { PlayerTooltip } from '~/components/MusicPlayer/MusicPlayerLayers';
import { ACCENT_FILL, ACCENT_TEXT } from '~/components/MusicPlayer/music-accent';
import { accentAt, dimmed } from '~/components/MusicPlayer/MusicPlayerParts';
import {
  TimedCommentStrip,
  usePlayerTimedComments,
} from '~/components/MusicPlayer/MusicPlayerTimedComments';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import type { MusicTrack } from '~/store/music-player.store';
import { useMusicPlayerStore, useMusicPlayheadStore } from '~/store/music-player.store';
import { formatPlaybackTime, playbackProgress, timeFromPointer } from '~/utils/audio-player';

const SEEK_STEP_SECONDS = 5;
// Decoded once at this resolution, then shown as one bar per WAVEFORM_BAR_PITCH px of the timeline,
// so a wide screen gets more bars rather than the same bars spread thin.
const WAVEFORM_PEAKS = 400;
const WAVEFORM_BAR_PITCH = 6;
const WAVEFORM_MIN_BARS = 40;
// The waveform decode downloads the whole song: wait until it has played this long, so skipping
// through songs costs nothing.
const WAVEFORM_AFTER_LISTENED_SEC = 1;

export const hoverSurface = 'transition-colors hover:bg-gray-1 dark:hover:bg-dark-5';
// The transport's and the volume's small icon buttons: the 36px buttons' hover, in 28px.
export const smallIconButton = clsx(
  'flex size-7 shrink-0 items-center justify-center rounded-md',
  hoverSurface
);
// The phone's now-playing sheet (Pencil `KUEww`): white controls over the cover's dark wash.
const sheetIconButton =
  'flex size-11 shrink-0 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10';

const store = useMusicPlayerStore.getState;

/**
 * Shuffle, previous, play/pause, next and repeat. `sheet` is the phone's now-playing sheet: the
 * row spans its width, with a 64px white play button (Pencil `KUEww`).
 */
export function Transport({ playing, sheet = false }: { playing: boolean; sheet?: boolean }) {
  const shuffle = useMusicPlayerStore((s) => s.shuffle);
  const repeat = useMusicPlayerStore((s) => s.repeat);
  const toggleColour = (on: boolean) => (on && !sheet ? { color: ACCENT_TEXT } : undefined);
  const toggleClass = (on: boolean) =>
    sheet
      ? clsx(sheetIconButton, on ? 'bg-white/15' : 'text-white/70')
      : clsx(smallIconButton, !on && dimmed);
  const skipClass = sheet ? sheetIconButton : clsx(smallIconButton, 'text-gray-9 dark:text-dark-0');
  const toggleSize = sheet ? 22 : 18;
  const skipSize = sheet ? 28 : 20;
  return (
    <div
      className={clsx(
        'flex shrink-0 items-center',
        sheet ? 'w-full justify-between px-2' : 'w-[200px] justify-center gap-2.5'
      )}
    >
      <PlayerTooltip label="Shuffle">
        <button
          type="button"
          aria-label="Shuffle"
          aria-pressed={shuffle}
          onClick={() => store().toggleShuffle()}
          className={toggleClass(shuffle)}
          style={toggleColour(shuffle)}
        >
          <IconArrowsShuffle size={toggleSize} />
        </button>
      </PlayerTooltip>
      <button
        type="button"
        aria-label="Previous"
        onClick={() => store().previous()}
        className={skipClass}
      >
        <IconPlayerSkipBackFilled size={skipSize} />
      </button>
      <PlayerTooltip label={playing ? 'Pause' : 'Play'}>
        <button
          type="button"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => store().togglePlay()}
          className={clsx(
            'flex shrink-0 items-center justify-center rounded-full transition-transform hover:scale-105',
            sheet ? 'size-16 bg-white text-dark-7' : 'size-10 text-white'
          )}
          style={sheet ? undefined : { backgroundColor: ACCENT_FILL }}
        >
          {playing ? (
            <IconPlayerPauseFilled size={sheet ? 28 : 20} />
          ) : (
            <IconPlayerPlayFilled size={sheet ? 28 : 20} />
          )}
        </button>
      </PlayerTooltip>
      <button type="button" aria-label="Next" onClick={() => store().next()} className={skipClass}>
        <IconPlayerSkipForwardFilled size={skipSize} />
      </button>
      <PlayerTooltip
        label={repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat'}
      >
        <button
          type="button"
          aria-label="Repeat"
          aria-pressed={repeat !== 'off'}
          onClick={() => store().cycleRepeat()}
          className={toggleClass(repeat !== 'off')}
          style={toggleColour(repeat !== 'off')}
        >
          {repeat === 'one' ? (
            <IconRepeatOnce size={toggleSize} />
          ) : (
            <IconRepeat size={toggleSize} />
          )}
        </button>
      </PlayerTooltip>
    </div>
  );
}

/**
 * Elapsed time, waveform and length: the only part of the bar that follows the playhead. On the
 * bar the three sit in a row; in the phone's now-playing sheet (`sheet`) the waveform spans the
 * sheet with the times under it, in white over the sheet's dark wash.
 */
export function Timeline({
  track,
  playing,
  accent,
  sheet = false,
  timedComments: withTimedComments = true,
}: {
  track: MusicTrack;
  playing: boolean;
  accent: MusicAccent | null;
  sheet?: boolean;
  /** False holds the timed comments back, e.g. while what holds the timeline moves. */
  timedComments?: boolean;
}) {
  const currentTime = useMusicPlayheadStore((s) => s.currentTime);
  const duration = useMusicPlayheadStore((s) => s.duration) || track.durationSec;
  const [barCount, setBarCount] = useState(100);
  const sliderRef = useResizeObserver<HTMLDivElement>((entry) =>
    setBarCount(
      Math.max(WAVEFORM_MIN_BARS, Math.floor(entry.contentRect.width / WAVEFORM_BAR_PITCH))
    )
  );
  const { url } = useEdgeUrl(track.url, { type: 'audio' });
  // A song started part-way in (restored after a page load, or started from a comment's or a
  // lyric's time) was chosen, not skipped through: draw it at once, even while paused.
  const listened = useMusicPlayerStore(
    (s) =>
      (s.playback?.listenedSec ?? 0) >= WAVEFORM_AFTER_LISTENED_SEC ||
      (s.playback?.startAtSec ?? 0) > 0
  );
  const peaks = useAudioPeaks(url, WAVEFORM_PEAKS, sliderRef, { enabled: listened });
  const bars = useMemo(() => (peaks ? resamplePeaks(peaks, barCount) : null), [peaks, barCount]);
  const progress = playbackProgress(currentTime, duration);
  const played = playing ? ACCENT_FILL : accentAt(50);
  const timedComments = usePlayerTimedComments(track.id);
  const unplayed = sheet ? 'bg-white/25' : 'bg-gray-4 dark:bg-dark-3';
  const timeClass = sheet ? 'text-xs text-white/80' : clsx('text-xs', dimmed);

  const seekFromPointer = (e: PointerEvent<HTMLElement>) =>
    seekMusicPlayer(timeFromPointer(e.clientX, e.currentTarget.getBoundingClientRect(), duration));

  const elapsed = (
    <span className={clsx('shrink-0', !sheet && 'w-[34px]', timeClass)}>
      {formatPlaybackTime(currentTime)}
    </span>
  );
  const length = (
    <span className={clsx('shrink-0', timeClass)}>{formatPlaybackTime(duration)}</span>
  );
  const waveform = (
    // The waveform alone sets this column's height, centred in the bar like the controls; the
    // comment avatars float over its top edge, so showing or hiding them moves nothing.
    <div className={clsx('relative min-w-0', sheet ? 'w-full' : 'flex-1')}>
      {withTimedComments && timedComments.show && timedComments.comments.length > 0 && (
        <TimedCommentStrip
          songId={track.id}
          comments={timedComments.comments}
          duration={duration}
          currentTime={currentTime}
          accent={accent}
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
        className="relative flex h-12 w-full min-w-0 cursor-pointer touch-none items-center"
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
              unplayedClassName={unplayed}
            />
            <div
              aria-hidden
              className={clsx(
                'absolute inset-y-0 w-0.5',
                sheet ? 'bg-white' : 'bg-black dark:bg-white'
              )}
              style={{ left: `${progress * 100}%` }}
            />
          </>
        ) : (
          <div className={clsx('h-1 w-full overflow-hidden rounded-full', unplayed)}>
            <div
              className="h-full"
              style={{ width: `${progress * 100}%`, backgroundColor: played }}
            />
          </div>
        )}
      </div>
    </div>
  );

  if (sheet)
    return (
      // The top 44px is the reached comment's label's own row (Pencil `QrxWW`: the bubble, then the
      // avatars, then the track): the label floats 8px above the avatars, which sit 12px over the
      // waveform, so it never covers the lyric lines above the timeline.
      <div className="flex w-full flex-col gap-1.5 pt-11">
        {waveform}
        <div className="flex justify-between">
          {elapsed}
          {length}
        </div>
      </div>
    );
  return (
    <>
      {elapsed}
      {waveform}
      {length}
    </>
  );
}
