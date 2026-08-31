import type { PersistedChallengeWinner } from '~/server/games/daily-challenge/challenge-winner-reconcile';

/**
 * Shared test double for `createChallengeWinner`'s resolved value.
 *
 * WHY THIS IS SHARED RATHER THAN COPIED PER FILE — the copies are what broke.
 *
 * `createChallengeWinner` used to resolve to a bare row id (`number | null`) and now resolves to the
 * PERSISTED row (`PersistedChallengeWinner | null`). Four suites kept doubling it as `1`, and that
 * stale double does not fail loudly — it fails SILENTLY, in the one direction that hides the bug:
 *
 *   `1` is truthy, so `reconcileWinnerToPersisted` gets past its `!persisted` guard;
 *   `(1).created` is `undefined` -> falsy, so it does not take the "fresh insert" early return;
 *   `Number.isFinite((1).place)` is false, so it takes the malformed-row DEGRADE path
 *   and returns the entry completely untouched.
 *
 * Every winner therefore flowed through the reconcile as a no-op. Deleting the reconcile call from
 * a completion path left the whole 316-file suite green — which is exactly how two of the three
 * changed call sites shipped with no coverage at all.
 *
 * Keeping one definition means the next shape change breaks in one place instead of silently
 * degrading four suites back into the same blind spot. The return type annotation is the guard: a
 * field added to `PersistedChallengeWinner` fails `tsc` here rather than quietly reintroducing the
 * degrade path at runtime.
 */
export function freshPersistedWinner(input: {
  place: number;
  buzzAwarded: number;
  pointsAwarded?: number;
  id?: number;
}): PersistedChallengeWinner {
  return {
    id: input.id ?? 1,
    place: input.place,
    buzzAwarded: input.buzzAwarded,
    pointsAwarded: input.pointsAwarded ?? 0,
    // The insert succeeded: this row IS what was just picked, so there is nothing to reconcile.
    created: true,
  };
}

/**
 * The conflict case: the insert hit the (challengeId, userId) unique constraint and this is the
 * STORED row that was already there — whose place/prize the payout must be keyed to, not the
 * freshly-picked one.
 */
export function conflictedPersistedWinner(input: {
  place: number;
  buzzAwarded: number;
  pointsAwarded?: number;
  id?: number;
}): PersistedChallengeWinner {
  return { ...freshPersistedWinner(input), created: false };
}
