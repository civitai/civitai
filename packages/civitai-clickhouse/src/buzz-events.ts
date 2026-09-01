// Column-shape rules for the `buzzEvents` table, which has two writers in two apps: the main app's
// reward pipeline (src/server/rewards/base.reward.ts) and the moderator's reportAccepted path
// (apps/moderator/src/lib/server/rewards.ts). The invariant belongs to the table, so the number
// lives beside the client that talks to it rather than once per app.

// 🔴 This must equal the ceiling of the DEPLOYED `buzzEvents.multiplier` column, which is
// Decimal(3, 2). Inserts run `async_insert=1, wait_for_async_insert=0`, so a value the column
// cannot hold is dropped server-side while the caller sees success — there is no backstop behind
// this. Widening the column was costed and declined (2026-08-24); if that changes, the column moves
// first and this follows in the same window, never the other way round.
// See src/server/clickhouse/migrations/2026-08-24-buzz-events-multiplier-width.sql.
export const BUZZ_EVENTS_MAX_MULTIPLIER = 9.99;

/**
 * Fit a multiplier to the column's range.
 *
 * For a processable reward this value is not audit — `process-rewards` reads it back out and pays
 * `awardAmount * multiplier` from it — so clamping UNDERPAYS. Dropping the row instead pays nothing
 * at all, which is why this floors rather than rejects. Callers that care should record the raw
 * value alongside the row.
 *
 * The floor is 0, not -9.99. The column is signed and would hold a small negative, but 0 is the
 * value `process-rewards` already understands: it marks the event `unqualified` with a zero award
 * and does NOT consume the user's cap. A negative kept as a negative is worse than the overflow
 * this guards — it passes that check, is recorded `awarded`, eats the cap, and is then dropped by
 * `sendAward`'s amount filter, leaving a row claiming a payout that never happened.
 * Justin's call, 2026-09-01.
 *
 * A non-finite input falls back to the base multiplier of 1 rather than passing NaN through: NaN is
 * a value the column cannot hold, which is the same silently-dropped row this exists to prevent.
 */
export function clampBuzzEventMultiplier(multiplier: number): number {
  if (!Number.isFinite(multiplier)) return 1;
  return Math.min(Math.max(multiplier, 0), BUZZ_EVENTS_MAX_MULTIPLIER);
}
