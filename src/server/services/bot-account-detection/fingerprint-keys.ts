/**
 * The namespace contract for cluster keys — shared by the index that BUILDS them (`evidence.ts`)
 * and the heuristic that READS them (`heuristics/similarity.ts`).
 *
 * 🔴 IT IS ITS OWN MODULE BECAUSE OF WHAT IT MUST NOT DRAG IN. `heuristics/` is deliberately pure:
 * every scoring function there is pure over a structurally-typed `signals` argument, and nothing in
 * that directory imports `evidence.ts` — which is what keeps the heuristics testable without a
 * database and keeps the ClickHouse client and `dbRead` out of their module graph. Putting these
 * declarations in `evidence.ts` and importing them from `similarity.ts` would have quietly ended
 * that property to share a string constant.
 *
 * 🔴 THERE IS ONE NAMESPACE NOW, AND IT IS KEPT DELIBERATELY RATHER THAN BY OVERSIGHT. This file
 * used to declare two — `text:` for a normalised comment and `file:` for an uploaded filename — and
 * the prefixes existed because `CohortSignals.membersPerFingerprint` is ONE `Map<string, number>`
 * carrying both: without them a filename and a comment that spell the same thing became one cluster,
 * which is two different claims counted as one. (That was not hypothetical. The text normaliser
 * stripped the dot out of `logo.jpg` to give `logo jpg`, and a comment reading "logo jpg" normalised
 * to exactly that string, so two accounts uploading `logo.jpg` and one commenting about it read as a
 * ring of three.)
 *
 * The comment source has since been deleted — see `heuristics/similarity.ts` — so that collision is
 * unreachable and a single-source index could key on the bare filename. `file:` stays anyway, for
 * two reasons that are about the CONSUMERS rather than about the index:
 *  - `run.ts` counts `evidence_distinct_filename_fingerprints` by counting keys carrying this
 *    prefix. Dropping it would silently redefine an existing run series rather than remove one.
 *  - Re-introducing a second source — model names, prompts, descriptions are all named as known
 *    blind spots in `similarity.ts` — would otherwise have to re-derive this decision and rewrite
 *    every key at once, which is the expensive half of the change, not the cheap half.
 *
 * The prefix is an implementation detail of the index and is stripped again before any of this
 * reaches a moderator — see `unprefixFingerprint` and `similarity.ts`'s `explain`.
 */

/** Namespace for a fingerprint derived from an uploaded FILENAME
 *  (`evidence.ts#filenameFingerprint`). */
export const FILENAME_FINGERPRINT_PREFIX = 'file:';

/**
 * Strip whichever namespace a fingerprint key carries, for display.
 *
 * A key with no known prefix is returned UNCHANGED rather than mangled — a blind
 * `slice(indexOf(':'))` would truncate at the first colon, which is a character a filename may
 * legitimately contain.
 */
export function unprefixFingerprint(key: string): string {
  if (key.startsWith(FILENAME_FINGERPRINT_PREFIX))
    return key.slice(FILENAME_FINGERPRINT_PREFIX.length);
  return key;
}
