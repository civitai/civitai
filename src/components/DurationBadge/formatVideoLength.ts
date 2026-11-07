const ONE_MINUTE = 60;
const ONE_HOUR = 3600;

/** Compact video length for badges: `7s`, `1m 2s`, `2m`, `1h 3m`. Zero or missing keeps `0:00`. */
export function formatVideoLength(seconds: number) {
  const total = Math.round(seconds);
  if (!total || total < 0) return '0:00';

  const hours = Math.floor(total / ONE_HOUR);
  const minutes = Math.floor((total % ONE_HOUR) / ONE_MINUTE);
  const secs = total % ONE_MINUTE;

  const parts =
    hours > 0
      ? [`${hours}h`, minutes > 0 ? `${minutes}m` : '']
      : [minutes > 0 ? `${minutes}m` : '', secs > 0 || minutes === 0 ? `${secs}s` : ''];
  return parts.filter(Boolean).join(' ');
}
