import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { resamplePeaks } from '~/components/Audio/resample-peaks';
import { WaveformBars } from '~/components/Audio/WaveformBars';
import { useResizeObserver } from '~/hooks/useResizeObserver';

/**
 * A song's peaks are decoded once at this resolution, wherever its waveform shows, so the decode is
 * shared (`useAudioPeaks` caches by url and count) and every waveform of a song draws the same.
 */
export const SONG_WAVEFORM_PEAKS = 400;
// One bar per WAVEFORM_BAR_PITCH px, so a wide timeline gets more bars rather than the same bars
// spread thin.
const WAVEFORM_BAR_PITCH = 6;
const WAVEFORM_MIN_BARS = 40;

/**
 * A song's waveform as the global player draws it: thin bars at a fixed pitch, the played ones in
 * `played` (a CSS colour), and a playhead line. Before its peaks are decoded, or when decoding
 * fails, a plain progress bar stands in. Fills its parent; the parent owns seeking.
 */
export function SongWaveform({
  peaks,
  progress,
  played,
  unplayedClassName = 'bg-gray-4 dark:bg-dark-3',
  playheadClassName = 'bg-black dark:bg-white',
}: {
  peaks: number[] | null;
  progress: number;
  played: string;
  unplayedClassName?: string;
  playheadClassName?: string;
}) {
  const [barCount, setBarCount] = useState(100);
  const ref = useResizeObserver<HTMLDivElement>((entry) =>
    setBarCount(
      Math.max(WAVEFORM_MIN_BARS, Math.floor(entry.contentRect.width / WAVEFORM_BAR_PITCH))
    )
  );
  const bars = useMemo(() => (peaks ? resamplePeaks(peaks, barCount) : null), [peaks, barCount]);

  return (
    <div
      ref={ref}
      className="relative flex size-full items-center"
      style={{ '--waveform-played': played } as React.CSSProperties}
    >
      {bars ? (
        <>
          <WaveformBars
            peaks={bars}
            progress={progress}
            className="justify-between"
            barClassName="min-w-px max-w-[3px] flex-1 rounded-[2px]"
            unplayedClassName={unplayedClassName}
          />
          <div
            aria-hidden
            className={clsx('absolute inset-y-0 w-0.5', playheadClassName)}
            style={{ left: `${progress * 100}%` }}
          />
        </>
      ) : (
        <div className={clsx('h-1 w-full overflow-hidden rounded-full', unplayedClassName)}>
          <div
            data-testid="song-progress-fill"
            className="h-full"
            style={{ width: `${progress * 100}%`, backgroundColor: played }}
          />
        </div>
      )}
    </div>
  );
}
