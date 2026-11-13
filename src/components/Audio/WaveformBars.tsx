import clsx from 'clsx';

/**
 * A track's peaks as vertical bars; the bars before `progress` (0..1) read as played. Played bars
 * take `--waveform-played` from an enclosing element, else the Civitai primary.
 */
export function WaveformBars({
  peaks,
  progress,
  className,
  barClassName = 'min-w-px flex-1 rounded-full',
  unplayedClassName = 'bg-black/20 dark:bg-white/35',
}: {
  peaks: number[];
  progress: number;
  className?: string;
  barClassName?: string;
  unplayedClassName?: string;
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
            barClassName,
            i < played
              ? 'bg-[var(--waveform-played,var(--mantine-primary-color-filled))]'
              : unplayedClassName
          )}
          style={{ height: `${Math.max(8, peak * 100)}%` }}
        />
      ))}
    </div>
  );
}
