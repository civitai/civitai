const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * No ETA is rendered shorter than this: a wait that runs over reads as a broken promise where one
 * that comes in early does not. The cost is that the fastest boosts show no visible gain.
 */
export const ETA_FLOOR_SECONDS = 2 * MINUTE;

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

type EtaBucket = {
  /** One value per rendered bucket, so a claim about a boost can never contradict the numbers beside it. */
  seconds: number;
  value: number;
  unit: 'minute' | 'hour' | 'day' | null;
};

/** The one rounding ladder: everything displayed or compared derives from it. */
function etaBucket(seconds: number): EtaBucket {
  const s = Math.max(seconds, ETA_FLOOR_SECONDS);
  if (s < MINUTE) return { seconds: MINUTE / 2, value: 0, unit: null };
  if (s < 10 * MINUTE) {
    const value = Math.round(s / MINUTE);
    return { seconds: value * MINUTE, value, unit: 'minute' };
  }
  if (s < 90 * MINUTE) {
    const value = Math.round(s / (5 * MINUTE)) * 5;
    return { seconds: value * MINUTE, value, unit: 'minute' };
  }
  if (s < 36 * HOUR) {
    const value = Math.round(s / HOUR);
    return { seconds: value * HOUR, value, unit: 'hour' };
  }
  const value = Math.round(s / DAY);
  return { seconds: value * DAY, value, unit: 'day' };
}

export function formatDownloadEta(seconds: number) {
  const { value, unit } = etaBucket(seconds);
  return unit ? `about ${plural(value, unit)}` : 'less than a minute';
}

/** Same ladder as `formatDownloadEta`, without the "about". */
export function formatDownloadEtaShort(seconds: number) {
  const { value, unit } = etaBucket(seconds);
  if (!unit) return '<1 min';
  if (unit === 'minute') {
    if (value < 60) return `${value} min`;
    return value === 60 ? '1 hr' : `1 hr ${value - 60} min`;
  }
  if (unit === 'hour') return `${value} hr`;
  return plural(value, 'day');
}

/** Whether two ETAs land in the same bucket — a gain the floor or the rounding has swallowed. */
export function etasPrintTheSame(etaSeconds?: number | null, boostedEtaSeconds?: number | null) {
  if (etaSeconds == null || boostedEtaSeconds == null) return false;
  return etaBucket(etaSeconds).seconds === etaBucket(boostedEtaSeconds).seconds;
}

/**
 * The queue card's rule. Its two ETAs are measured at different moments — the boosted one when the
 * workflow queued, the plain one live — so a download that has since sped up can quote a "boost"
 * slower than the current wait. An unknown plain ETA qualifies: nothing contradicts it.
 */
export function boostBuysVisibleTime(
  etaSeconds?: number | null,
  boostedEtaSeconds?: number | null
) {
  if (boostedEtaSeconds == null) return false;
  if (etaSeconds == null) return true;
  return etaBucket(boostedEtaSeconds).seconds < etaBucket(etaSeconds).seconds;
}

/** How many times faster a boost makes the download, when that is worth saying. */
export function downloadSpeedup(etaSeconds?: number | null, boostedEtaSeconds?: number | null) {
  if (!etaSeconds || !boostedEtaSeconds) return null;
  const ratio = etaBucket(etaSeconds).seconds / etaBucket(boostedEtaSeconds).seconds;
  return ratio >= 2 ? Math.round(ratio) : null;
}
