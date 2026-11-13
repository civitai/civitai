import { IconPlayerPauseFilled, IconPlayerPlayFilled } from '@tabler/icons-react';
import { useRef } from 'react';
import { useAudioPeaks } from '~/components/Audio/useAudioPeaks';
import { useMediaPlayback } from '~/components/Audio/useMediaPlayback';
import { WaveformBars } from '~/components/Audio/WaveformBars';
import { EdgeAudio } from '~/components/EdgeMedia/EdgeAudio';
import { useEdgeUrl } from '~/client-utils/cf-images-utils';
import { formatPlaybackTime } from '~/utils/audio-player';

const SEEK_STEP_SECONDS = 5;
const WAVEFORM_BARS = 48;

/**
 * Play/pause, a seekable waveform and the length of a stored song. The waveform is decoded once
 * the player nears the viewport; until then, or when decoding fails, a plain progress bar stands in.
 */
export function SongPreviewPlayer({
  src,
  duration: storedDuration,
}: {
  src: string;
  duration?: number;
}) {
  const sliderRef = useRef<HTMLDivElement>(null);
  const { url } = useEdgeUrl(src, { type: 'audio' });
  const peaks = useAudioPeaks(url, WAVEFORM_BARS, sliderRef);
  const {
    mediaRef,
    playing,
    currentTime,
    duration,
    progress,
    togglePlay,
    seekTo,
    scrubHandlers,
    mediaEvents,
  } = useMediaPlayback<HTMLAudioElement>(storedDuration);

  return (
    <div className="flex w-full items-center gap-2.5 rounded-lg bg-black/5 px-2.5 py-2 dark:bg-black/35">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <EdgeAudio ref={mediaRef} src={src} controls={false} className="hidden" {...mediaEvents} />
      <button
        type="button"
        onClick={togglePlay}
        aria-label={playing ? 'Pause' : 'Play'}
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--mantine-primary-color-filled)] text-[var(--mantine-primary-color-contrast)] transition-transform hover:scale-105"
      >
        {playing ? <IconPlayerPauseFilled size={14} /> : <IconPlayerPlayFilled size={14} />}
      </button>
      <div
        ref={sliderRef}
        className="group flex h-8 min-w-0 flex-1 cursor-pointer touch-none items-center"
        {...scrubHandlers}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') seekTo(currentTime + SEEK_STEP_SECONDS);
          else if (e.key === 'ArrowLeft') seekTo(currentTime - SEEK_STEP_SECONDS);
          else return;
          e.preventDefault();
        }}
        role="slider"
        tabIndex={0}
        aria-label="Song progress"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        aria-valuetext={`${formatPlaybackTime(currentTime)} of ${formatPlaybackTime(duration)}`}
      >
        {peaks ? (
          <WaveformBars peaks={peaks} progress={progress} />
        ) : (
          <div className="h-1 w-full overflow-hidden rounded-full bg-black/15 transition-[height] group-hover:h-1.5 dark:bg-white/35">
            <div
              data-testid="song-progress-fill"
              className="h-full bg-[var(--mantine-primary-color-filled)]"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
        )}
      </div>
      <span className="shrink-0 text-xs text-gray-6 dark:text-dark-2">
        {formatPlaybackTime(duration)}
      </span>
    </div>
  );
}
