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

/** The same buckets as `formatDownloadEta`, for figures big enough to carry no "about". */
export function formatDownloadEtaShort(seconds: number) {
  if (seconds < MINUTE) return '<1 min';
  if (seconds < 10 * MINUTE) return `${Math.round(seconds / MINUTE)} min`;
  if (seconds < 90 * MINUTE) {
    const minutes = Math.round(seconds / (5 * MINUTE)) * 5;
    if (minutes < 60) return `${minutes} min`;
    return minutes === 60 ? '1 hr' : `1 hr ${minutes - 60} min`;
  }
  if (seconds < 36 * HOUR) return `${Math.round(seconds / HOUR)} hr`;
  return plural(Math.round(seconds / DAY), 'day');
}

/** How many times faster a boost makes the download, when that is worth saying. */
export function downloadSpeedup(etaSeconds?: number | null, boostedEtaSeconds?: number | null) {
  if (!etaSeconds || !boostedEtaSeconds) return null;
  const ratio = etaSeconds / boostedEtaSeconds;
  return ratio >= 2 ? Math.round(ratio) : null;
}
