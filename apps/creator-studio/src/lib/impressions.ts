// Impressions were never recorded before these dates and cannot be backfilled, so anything earlier is absent
// rather than low. The rollout also ramped: 1% of traffic from 2026-08-17 20:44 UTC, 100% from 2026-08-18
// 02:44 UTC. That makes the first day a ~1% sample of three hours and August 2026 a half-counted month, so a
// comparison touching either reads as a ~100x swing in reach that never happened.
export const IMPRESSIONS_SINCE = '2026-08-17';
export const IMPRESSIONS_FULL = '2026-08-18';

// Announcement reach, clicks and mute events start here — the day that instrumentation shipped,
// which is later than the feed dates above and unrelated to them. It is also the floor every
// `actions` read uses, so moving it earlier makes those queries scan more of a 92.8M-row table
// for rows that cannot exist.
export const ANNOUNCEMENT_METRICS_SINCE = '2026-09-04';

const monthDay = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const long = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return monthDay.format(new Date(Date.UTC(y, m - 1, d)));
};

export const IMPRESSIONS_SINCE_LABEL = long(IMPRESSIONS_SINCE);
export const IMPRESSIONS_FULL_LABEL = long(IMPRESSIONS_FULL);

// A delta is only honest once the WHOLE comparison window sits after full rollout. Comparison ranges are always
// whole calendar months, so testing `from` suppresses August 2026 — the ramp month, which holds ~14 days of a
// month and three of those hours at 1% traffic, and would otherwise render +100-300% on every row.
export const impressionsComparable = (compareFrom: string) => compareFrom >= IMPRESSIONS_FULL;

export const ANNOUNCEMENT_METRICS_SINCE_LABEL = long(ANNOUNCEMENT_METRICS_SINCE);
