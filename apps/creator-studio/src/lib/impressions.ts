// First day `daily_impressions` holds any rows. Counts before this date are absent, not low, and the ramp
// started partway through it — so the banner names the date rather than letting a creator read the gap as
// their own reach collapsing.
export const IMPRESSIONS_SINCE = '2026-08-17';

export function formatImpressionsSince(): string {
  const [y, m, d] = IMPRESSIONS_SINCE.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
