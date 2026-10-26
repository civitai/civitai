/**
 * Seconds from a 429's `Retry-After` (delta-seconds or an HTTP date), clamped to [1, 3600];
 * undefined when absent or unparseable.
 */
export function getRetryAfterSeconds(response: Pick<Response, 'headers'> | undefined) {
  const value = response?.headers?.get?.('retry-after')?.trim();
  if (!value) return undefined;
  const seconds = /^\d+$/.test(value)
    ? Number(value)
    : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  if (!Number.isFinite(seconds)) return undefined;
  return Math.min(3600, Math.max(1, seconds));
}
