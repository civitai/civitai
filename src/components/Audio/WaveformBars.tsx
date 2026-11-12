import clsx from 'clsx';

/** A track's peaks as vertical bars; the bars before `progress` (0..1) read as played. */
export function WaveformBars({
  peaks,
  progress,
  className,
}: {
  peaks: number[];
  progress: number;
  className?: string;
}) {
  const played = Math.round(Math.max(0, Math.min(1, progress)) * peaks.length);
  return (
    <div className={clsx('flex size-full items-center gap-px', className)} aria-hidden>
      {peaks.map((peak, i) => (
        <div
          key={i}
          data-testid="waveform-bar"
          data-played={i < played}
          className={clsx(
            'min-w-px flex-1 rounded-full',
            i < played ? 'bg-[var(--mantine-color-pink-6)]' : 'bg-black/20 dark:bg-white/35'
          )}
          style={{ height: `${Math.max(8, peak * 100)}%` }}
        />
      ))}
    </div>
  );
}
