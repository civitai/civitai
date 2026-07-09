/**
 * App Store Listings (W13) — MACHINE-READABLE scan-status discriminators for the
 * listing-asset attach flow (`setIcon` / `setCover` / `addScreenshot`).
 *
 * SHARED source of truth (imported by BOTH server and client) so the server's
 * thrown code and the client's retry decision can never drift.
 *
 * The problem this replaces: the attach used to distinguish a RETRIABLE
 * "still scanning" state from a TERMINAL scan failure ONLY by the human message
 * STRING, and the client decided whether to keep polling by REGEX-matching that
 * prose. Rewording the message silently broke the poller, and a retriable state
 * returned `BAD_REQUEST` (which semantically implies non-retriable bad input).
 *
 * Now the retriable-vs-terminal signal is STRUCTURAL:
 *   - the tRPC error `code` — `CONFLICT` (retriable) vs `BAD_REQUEST` (terminal) —
 *     which tRPC ALWAYS surfaces to the client as `error.data.code`, AND
 *   - this machine token on `error.data.scanStatus`, which also distinguishes the
 *     two terminal sub-cases (FAILED vs BLOCKED) for display/telemetry.
 *
 * The human messages are unchanged — they remain for DISPLAY only; nothing keys a
 * decision off them.
 */
export const SCAN_STATUS = {
  /** Image scan hasn't completed yet (Pending / not-yet-`Scanned`) — RETRIABLE. */
  PENDING: 'SCAN_PENDING',
  /** Scanner couldn't fetch the bytes (`ImageIngestionStatus.NotFound`) — TERMINAL. */
  FAILED: 'SCAN_FAILED',
  /** Image was rejected during scanning (`ImageIngestionStatus.Blocked`) — TERMINAL. */
  BLOCKED: 'SCAN_BLOCKED',
} as const;

export type ScanStatusCode = (typeof SCAN_STATUS)[keyof typeof SCAN_STATUS];

const SCAN_STATUS_VALUES: ReadonlySet<string> = new Set(Object.values(SCAN_STATUS));

/** Type-guard: is `value` one of the known scan-status tokens? (structural, not prose). */
export function isScanStatusCode(value: unknown): value is ScanStatusCode {
  return typeof value === 'string' && SCAN_STATUS_VALUES.has(value);
}

/** Only PENDING is retriable; FAILED / BLOCKED are terminal. */
export function isRetriableScanStatus(code: ScanStatusCode): boolean {
  return code === SCAN_STATUS.PENDING;
}

/**
 * Extract the scan-status token from an unknown tRPC error `cause`. tRPC wraps a
 * plain-object `cause` in an `UnknownCauseError` (via `Object.assign`), so the
 * `scanStatus` property is present on the instance. Used by the tRPC
 * `errorFormatter` to surface the token on `error.data.scanStatus`.
 */
export function scanStatusFromCause(cause: unknown): ScanStatusCode | undefined {
  if (cause && typeof cause === 'object' && 'scanStatus' in cause) {
    const value = (cause as { scanStatus?: unknown }).scanStatus;
    if (isScanStatusCode(value)) return value;
  }
  return undefined;
}
