export const DEFAULT_CASES_PER_SECOND = 12;

export function estimateSeconds(scans: number, casesPerSecond: number | null): number {
  const rate = casesPerSecond && casesPerSecond > 0 ? casesPerSecond : DEFAULT_CASES_PER_SECOND;
  return Math.ceil(scans / rate);
}

export const aboutTime = (seconds: number) =>
  seconds < 60
    ? `About ${Math.max(5, Math.round(seconds / 5) * 5)} s.`
    : `About ${Math.round(seconds / 60)} min.`;
