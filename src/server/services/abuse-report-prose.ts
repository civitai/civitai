/**
 * The words the abuse-board detectors put in front of a moderator.
 *
 * 🔴 WHY THIS IS SHARED AND NOT COPIED INTO EACH PRODUCER. A `reason` is the only free text on the
 * board, and it is what a non-technical moderator reads to decide whether an account is abusive.
 * Several detectors post to that board and they had drifted into different registers: one wrote
 * complete sentences, one ended in a machine-readable dump, and each spelled "nothing was actioned"
 * its own way in its own position. A sentence duplicated per producer diverges the first time one of
 * them is edited, and the divergence is invisible — every producer's own suite keeps passing while
 * the BOARD stops reading as one surface. So the parts that must agree live here, once.
 *
 * ⚠️ IT IS SHARED BY THE TWO PRODUCERS BUILT IN THIS REPO — `bot-account-detection` and
 * `new-order-abuse-detection`. `reaction-withdrawal-detection` has not been migrated onto it, and
 * detectors deployed outside this repo cannot be; this module standardises what it reaches, which is
 * less than the whole board.
 *
 * 🔴 DEPENDENCY-FREE, AND THAT IS ENFORCED RATHER THAN INTENDED. `bot-account-detection` is a
 * shadow-mode detector whose whole guarantee is that nothing in its module graph can act on an
 * account, and its `__tests__/no-write-surface.test.ts` walks only that detector's own directory —
 * so this file, imported from outside that tree, would otherwise be allowlisted by name and never
 * read. That suite therefore asserts THIS module imports nothing at all. Adding an import here
 * fails it, which is the intended way to find out that a shared prose helper has become a
 * dependency of a safety property.
 */

/**
 * The word a count governs, singular or plural.
 *
 * Usually a noun (`plural(n, 'rating')`), sometimes a VERB — `plural(n, 'was', 'were')` — because
 * `1 were auto-smited` is the same defect as `1 rating(s)` and a helper that only did nouns would
 * have left it standing. Irregular forms go in the third argument; the default just appends `s`.
 *
 * 🔴 IT RETURNS THE WORD, NOT THE PHRASE, so the caller keeps control of how the NUMBER is rendered.
 * The producers disagree on that deliberately — `new-order-abuse-detection` runs its counts through
 * `toLocaleString()` because they reach five digits, `bot-account-detection` renders per-surface
 * counts bare — and folding the number in here would have quietly imposed one producer's choice on
 * the other, changing numbers on the board as a side effect of a grammar fix.
 *
 * `Math.abs` so a negative count reads as a plural ("-1 ratings" is wrong, but every other negative
 * is plural and none of these counts can be negative anyway; the guard is here so the answer is not
 * accidentally singular for -1 alone).
 */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return Math.abs(count) === 1 ? singular : pluralForm;
}

/**
 * The one sentence both in-repo producers end a non-actioned finding with.
 *
 * 🔴 THE POSITION IS PART OF THE STANDARD, NOT JUST THE WORDS: LAST. A moderator reads the evidence
 * and then what was done about it, and a disclaimer that LEADS is read as a header and skipped —
 * which is exactly how `bot-account-detection` came to open every row with a phrase
 * ("Shadow-mode observation — NOT actioned.") that named an internal rollout phase rather than
 * telling anyone what had happened to the account.
 *
 * 🔴 IT IS A CLAIM ABOUT THE ROW, SO ONLY A PRODUCER THAT CANNOT ACT MAY USE IT UNCONDITIONALLY.
 * `bot-account-detection` holds no write client at all; `new-order-abuse-detection` DOES act, so it
 * uses this only on the branch where `actioned` is false and says what it did on the other. A
 * producer that grew a write path and kept this sentence would put "no action was taken" beside a
 * live penalty — the failure its own `toFinding` docstring calls the worse of the two directions.
 *
 * The wording is `new-order-abuse-detection`'s, unchanged: it was the one already reading as plain
 * English, and moving the OTHER producer onto it is what standardising meant here.
 */
export const NO_ACTION_TAKEN =
  'No action was taken by this scan — filed for a moderator to review.';
