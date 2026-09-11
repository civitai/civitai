const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** The orchestrator's ETA is a projection from current speed and the queue ahead, not a promise. */
export function formatDownloadEta(seconds: number) {
  if (seconds < MINUTE) return 'less than a minute';
  if (seconds < 10 * MINUTE) return `about ${plural(Math.round(seconds / MINUTE), 'minute')}`;
  if (seconds < 90 * MINUTE)
    return `about ${plural(Math.round(seconds / (5 * MINUTE)) * 5, 'minute')}`;
  if (seconds < 36 * HOUR) return `about ${plural(Math.round(seconds / HOUR), 'hour')}`;
  return `about ${plural(Math.round(seconds / DAY), 'day')}`;
}
