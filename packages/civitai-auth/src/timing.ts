// Tiny, infra-free timing helpers shared by the session-resolution legs (session-client fetchIdentity + the
// verify JWKS refetch). Kept in the package (no prom-client / no infra dep — base-package rules); the CALLING
// app injects the actual metric emission via the `onIdentityLeg` / `onJwksLeg` callbacks and these helpers just
// produce the numbers.

/** High-resolution monotonic clock in ms, falling back to Date.now where `performance` is unavailable. */
export const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

/** Elapsed seconds since a `now()` start mark — the unit prom histograms expect. */
export const elapsed = (startMs: number): number => (now() - startMs) / 1000;

/**
 * True when an error is a bounded-wait TIMEOUT from one of the two mechanisms this fix adds:
 *  - `AbortSignal.timeout(...)` on the identity fetch → DOMException `TimeoutError`.
 *  - jose `createRemoteJWKSet(..., { timeoutDuration })` on the JWKS refetch → `JWKSTimeout`
 *    (code `ERR_JWKS_TIMEOUT`).
 * Everything else (bad signature, 5xx, network reset) is NOT a timeout.
 */
export const isTimeoutError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const { name, code } = err as { name?: string; code?: string };
  return name === 'TimeoutError' || name === 'JWKSTimeout' || code === 'ERR_JWKS_TIMEOUT';
};
