export type SliderRange = { min: number; max: number; step?: number };

const decimals = (n: number) => n.toString().split('.')[1]?.length ?? 0;

/**
 * Clamp to the range and snap to the nearest step counted from `min`, rounded to the step's
 * precision so 0.05 steps read 0.7, not 0.7000000000000001.
 */
export function snapToStep(value: number, { min, max, step }: SliderRange): number {
  const clamped = Math.min(max, Math.max(min, value));
  if (!step || step <= 0) return clamped;
  const snapped = min + Math.round((clamped - min) / step) * step;
  const places = Math.max(decimals(step), decimals(min));
  return Math.min(max, Number(snapped.toFixed(places)));
}

/** The snapped value at a position along the track, `ratio` 0 at the left end and 1 at the right. */
export function valueAtRatio(ratio: number, range: SliderRange): number {
  return snapToStep(range.min + ratio * (range.max - range.min), range);
}

/** Where a value sits along the track, 0 to 1. */
export function ratioOf(value: number, { min, max }: SliderRange): number {
  if (max <= min) return 0;
  return (Math.min(max, Math.max(min, value)) - min) / (max - min);
}
