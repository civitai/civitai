/**
 * Winner payout reconciliation — pure, no DB/LLM imports.
 *
 * A challenge's winner-prize payout is made idempotent ONLY by its externalTransactionId, which
 * embeds the winner's place (`challenge-winner-prize-{challengeId}-{userId}-place-{place}`). There
 * is no dedupe of the payout anywhere downstream. So if a user is paid at place 1 and a later run
 * re-picks that same user at place 2, the second payout carries a DIFFERENT key, does not conflict,
 * and mints a second prize.
 *
 * The `ChallengeWinner` table is uniquely keyed on (challengeId, userId) — NOT on
 * (challengeId, place) — so that re-pick cannot write a second row: the insert conflicts and the
 * stored row keeps its ORIGINAL place. That makes the stored row the only durable record of what
 * was actually paid, and therefore the authority the payout must key to.
 *
 * `reconcileWinnerToPersisted` is the point where a freshly-picked placement is folded back onto
 * the persisted one, so record and payment can never diverge.
 */

/** The persisted state of a `ChallengeWinner` row after a create attempt. */
export type PersistedChallengeWinner = {
  id: number;
  place: number;
  buzzAwarded: number;
  pointsAwarded: number;
  /** true = this call inserted the row; false = the row already existed and this is its stored state. */
  created: boolean;
};

/** The in-memory winner shape both completion paths build and then pay out. */
export type WinnerPayoutEntry = {
  userId: number;
  imageId: number | null;
  position: number;
  prize: number;
  reason: string | null;
};

/**
 * Fold a freshly-picked winner entry onto the placement that is actually persisted.
 *
 * - Fresh insert (`created: true`) — nothing to reconcile, the row matches what we picked.
 * - `null` — the create neither inserted nor resolved to a readable row (structurally unreachable:
 *   (challengeId, userId) is the table's only unique constraint). Left untouched deliberately, so
 *   this fix can never turn into an UNDER-payment; the create path logs it loudly instead.
 * - Existing row — its place/prize win. Paying the freshly-picked place instead is exactly the
 *   double-mint: the user was already paid under the recorded place's transaction id.
 *
 * A placement is only ever adopted when it is a real finite number. This is a money path: an
 * absent/garbled field must degrade to "keep what we picked" rather than propagate `undefined`
 * into the payout amount and the transaction id.
 */
export function reconcileWinnerToPersisted<T extends WinnerPayoutEntry>(
  entry: T,
  persisted: PersistedChallengeWinner | null
): T {
  if (!persisted || persisted.created) return entry;
  if (!Number.isFinite(persisted.place) || !Number.isFinite(persisted.buzzAwarded)) return entry;
  if (persisted.place === entry.position && persisted.buzzAwarded === entry.prize) return entry;
  return { ...entry, position: persisted.place, prize: persisted.buzzAwarded };
}
