/** Assumed when a set has no finished run to measure. */
export const DEFAULT_CASES_PER_SECOND = 8;

export function estimateSeconds(scans: number, casesPerSecond: number | null): number {
  const rate = casesPerSecond && casesPerSecond > 0 ? casesPerSecond : DEFAULT_CASES_PER_SECOND;
  return Math.ceil(scans / rate);
}

export const aboutMinutes = (seconds: number) =>
  `About ${Math.max(1, Math.round(seconds / 60))} min.`;
