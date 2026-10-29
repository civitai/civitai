export const percent = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`;

/** A wait as `45s`, `3m 05s` or `1h 02m`. */
export const formatWait = (seconds: number): string => {
  const total = Math.max(0, Math.ceil(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};
