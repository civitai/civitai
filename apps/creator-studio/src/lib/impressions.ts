// Impressions were never recorded before these dates and cannot be backfilled, so anything earlier is absent
// rather than low. The rollout also ramped: 1% of traffic from 2026-08-17 20:44 UTC, 100% from 2026-08-18
// 02:44 UTC. That makes the first day a ~1% sample of three hours, and a day-over-day comparison across the
// boundary a ~100x rollout artefact rather than a change in reach — which is why the surfaces say so and
// suppress deltas that reach back past it.
export const IMPRESSIONS_SINCE = '2026-08-17';
export const IMPRESSIONS_FULL = '2026-08-18';

const long = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

export const formatImpressionsSince = () => long(IMPRESSIONS_SINCE);
export const formatImpressionsFull = () => long(IMPRESSIONS_FULL);
