/**
 * The namespace contract for cluster keys — shared by the index that BUILDS them (`evidence.ts`)
 * and the heuristic that READS them (`heuristics/similarity.ts`).
 *
 * 🔴 IT IS ITS OWN MODULE BECAUSE OF WHAT IT MUST NOT DRAG IN. `heuristics/` is deliberately pure:
 * every scoring function there is pure over a structurally-typed `signals` argument, and nothing in
 * that directory imports `evidence.ts` — which is what keeps the heuristics testable without a
 * database and keeps the ClickHouse client and `dbRead` out of their module graph. Putting these
 * three declarations in `evidence.ts` and importing them from `similarity.ts` would have quietly
 * ended that property to share two string constants.
 *
 * 🔴 WHY THE KEYS ARE NAMESPACED AT ALL. `CohortSignals.membersPerFingerprint` is ONE
 * `Map<string, number>` carrying both fingerprint sources, so without a prefix a filename and a
 * normalised comment that spell the same thing become one cluster — and the two are not the same
 * claim. That is not hypothetical: `normalizeContent` strips the dot out of `logo.jpg` to give
 * `logo jpg`, and a comment reading "logo jpg" normalises to exactly that string too. Two accounts
 * uploading `logo.jpg` and one commenting about it would have read as a ring of three.
 *
 * The prefixes are an implementation detail of the index and are stripped again before any of this
 * reaches a moderator — see `unprefixFingerprint` and `similarity.ts`'s `explain`.
 */

/** Namespace for a fingerprint derived from posted TEXT (`evidence.ts#contentFingerprint`). */
export const TEXT_FINGERPRINT_PREFIX = 'text:';

/** Namespace for a fingerprint derived from an uploaded FILENAME
 *  (`evidence.ts#filenameFingerprint`). */
export const FILENAME_FINGERPRINT_PREFIX = 'file:';

/**
 * Strip whichever namespace a fingerprint key carries, for display.
 *
 * A key with no known prefix is returned UNCHANGED rather than mangled — a blind
 * `slice(indexOf(':'))` would truncate a normalised comment at its first colon, which is a
 * character ordinary text contains and every generation-parameter paste is full of.
 */
export function unprefixFingerprint(key: string): string {
  if (key.startsWith(TEXT_FINGERPRINT_PREFIX)) return key.slice(TEXT_FINGERPRINT_PREFIX.length);
  if (key.startsWith(FILENAME_FINGERPRINT_PREFIX))
    return key.slice(FILENAME_FINGERPRINT_PREFIX.length);
  return key;
}
