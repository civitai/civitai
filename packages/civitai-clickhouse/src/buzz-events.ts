/**
 * The `buzzEvents.multiplier` column is `Decimal(3, 2)`, so 9.99 is the largest value it can hold.
 *
 * 🔴 This must equal the ceiling of the DEPLOYED column. Inserts run `async_insert=1,
 * wait_for_async_insert=0`, so ClickHouse accepts a row it cannot parse and drops it server-side
 * afterwards — the caller sees success and no error anywhere. Raising this without moving the column
 * first therefore costs rows silently, and for a processable reward a dropped `pending` row is the
 * whole payment.
 *
 * Widening the column was costed and declined (2026-08-24): the ceiling is not reachable today and it
 * was not worth a mutation over 1.4 billion rows. If that changes, the column moves first and this
 * follows in the same window — never the other way round. See
 * `src/server/clickhouse/migrations/2026-08-24-buzz-events-multiplier-width.sql`.
 *
 * It lives in this package because both the main app and `apps/moderator` write the table, and a
 * writer that expresses the ceiling itself is a writer that drifts from the column.
 */
export const BUZZ_EVENTS_MAX_MULTIPLIER = 9.99;

/**
 * Fits a multiplier to the column. A clamp UNDERPAYS rather than losing the row, which is the better
 * of the two failures: `sendAward` pays `awardAmount * multiplier` from the value stored here.
 * Returns the input unchanged when it already fits, so a caller can tell a clamp from a no-op.
 */
export function clampBuzzEventMultiplier(multiplier: number): number {
  if (!Number.isFinite(multiplier)) return BUZZ_EVENTS_MAX_MULTIPLIER;
  return Math.min(multiplier, BUZZ_EVENTS_MAX_MULTIPLIER);
}
