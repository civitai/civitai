// No imports, on purpose: `~/server/services/feature-flags.service` uses this and is reachable from
// the client bundle, so it must not pull the Flipt client (and the server env) in with it. The
// Flipt-bound helpers live in `~/server/utils/otel-withspan-gate`, which re-exports this.

/** How long one read of the flag is reused by default. A flip takes effect within this window. */
export const CACHED_FLAG_GATE_REFRESH_MS = 5_000;

/**
 * Wrap a synchronous flag read so it runs at most once per `refreshMs`. `withSpan` consults the
 * gate on every call that has an unsampled parent — several times per request — so even the
 * Flipt eval-cache lookup (a key build plus a map read) is paid once per window instead.
 * `null` (unknown flag, or Flipt not initialized yet) and any throw read as OFF.
 */
export function createCachedFlagGate(
  read: () => boolean | null,
  refreshMs: number = CACHED_FLAG_GATE_REFRESH_MS,
  now: () => number = Date.now
): () => boolean {
  let value = false;
  let expiresAt = Number.NEGATIVE_INFINITY;
  return () => {
    const t = now();
    if (t >= expiresAt) {
      try {
        value = read() === true;
      } catch {
        value = false;
      }
      expiresAt = t + refreshMs;
    }
    return value;
  };
}
