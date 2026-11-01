export type SliderZone = { start: number; end: number };

/** A zero-width band keeps a sliver so it still paints as a tick. */
export function sliderZone(
  range: { min: number; max: number },
  recommended: { min: number; max: number } | undefined
): SliderZone | undefined {
  const { min, max } = range;
  if (!recommended || max <= min) return undefined;
  const pct = (v: number) => ((Math.min(Math.max(v, min), max) - min) / (max - min)) * 100;
  const start = pct(recommended.min);
  return { start, end: Math.max(pct(recommended.max), start + 0.75) };
}

/**
 * Mantine's track paints through its ::before pseudo (`--track-bg`), which no inline style
 * reaches, so the zone clears that paint and draws on the track itself.
 */
export function sliderZoneStyles(zone: SliderZone) {
  const yellow = 'var(--mantine-color-yellow-6)';
  const green = 'var(--mantine-color-green-6)';
  return {
    track: {
      '--track-bg': 'transparent',
      borderRadius: 'var(--slider-radius)',
      background: `linear-gradient(to right, ${yellow} ${zone.start}%, ${green} ${zone.start}%, ${green} ${zone.end}%, ${yellow} ${zone.end}%)`,
      opacity: 0.85,
    },
    bar: { background: 'transparent' },
  };
}
