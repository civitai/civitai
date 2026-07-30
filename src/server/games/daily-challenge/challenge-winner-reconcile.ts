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

/**
 * Drop winner entries that would pay a creator already paid earlier in the SAME batch.
 *
 * Nothing upstream guarantees one placement per creator. `generateWinners` returns raw LLM JSON —
 * "Select exactly 3 different winners" is prompt text, not a validated constraint — and both
 * completion paths map winners to entries with a `find()` by creatorId, so one creator named in two
 * slots yields two entries holding two different places. Before the reconcile above existed, those
 * two entries paid under two distinct transaction ids: a genuine double mint with no re-pick
 * involved. With it, they collapse onto the same stored place and hence the same id — a duplicate
 * id inside a single batch, handed to an external Buzz service whose within-batch behaviour is not
 * observable from this repo. Neither outcome is acceptable, so the duplicate is dropped here.
 *
 * That is safe by construction: `ChallengeWinner` is uniquely keyed on (challengeId, userId), so a
 * creator has at most ONE row per challenge and therefore at most one thing to be paid for. A
 * second placement for the same creator is a duplicate of the first, never a second prize.
 *
 * Keyed on the CREATOR, not on the full externalTransactionId, and that difference is load-bearing.
 * Once reconciled the two entries share an id, so an id-keyed dedupe would catch them — but only
 * then. If reconciliation did not happen (`createChallengeWinner` returned `null`, its
 * unresolved-conflict branch) the entries keep their distinct places, produce two distinct
 * never-before-seen ids, and an id-keyed dedupe would pass both through to be minted twice. Keying
 * on the creator closes that case too, and cannot itself over-drop: the id embeds the creator, so
 * two ids that differ must have different creators.
 *
 * The FIRST occurrence wins. Entries are built in placement order, so the first holds the best
 * place and therefore the largest prize — keeping a later, worse placement instead would turn a
 * duplicate pick into an under-payment.
 *
 * Lives in this module rather than beside `buildWinnerPayoutTransactions` for a mundane but real
 * reason: `challenge-funding` is mocked with an explicit export list by 15 test files, so a new
 * export there breaks all of them, while this pure module is imported for real everywhere.
 */
export function dedupeWinnersForPayout<T extends { userId: number }>(
  winners: T[]
): { winners: T[]; dropped: T[] } {
  const seen = new Set<number>();
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const entry of winners) {
    if (seen.has(entry.userId)) dropped.push(entry);
    else {
      seen.add(entry.userId);
      kept.push(entry);
    }
  }
  return { winners: kept, dropped };
}
