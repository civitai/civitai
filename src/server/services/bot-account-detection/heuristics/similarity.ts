import type { BotAccountHeuristic } from '../scoring';
import { rampScore } from './ramp';

/**
 * HEURISTIC 3 — the same text, posted by accounts that are supposed to be strangers.
 *
 * 🔴 NO EXISTING IMPLEMENTATION TO ADAPT, so the approach is stated here in full rather than by
 * reference. The requirement is "the same shill text pasted N times across new accounts", and the
 * constraint that shaped every decision below is that a moderator must be able to READ the reason
 * and see why — which rules out anything whose output is a distance nobody can picture.
 *
 * WHAT IT DOES: reduce each comment to a normalised fingerprint (`evidence.ts#contentFingerprint` —
 * lowercased, links and digit runs masked, punctuation dropped, whitespace collapsed), then count how
 * many DISTINCT cohort members produced each fingerprint. An account's score is the size of the
 * largest group its own text belongs to.
 *
 * 🔴 WHY NOT A REAL SIMILARITY MEASURE. Cosine over TF-IDF, edit distance, MinHash and friends all
 * answer a better question, and all three fail the constraint above in the same way: the finding
 * would read "similarity 0.83 to a cluster of 6", which no moderator can check and nobody can
 * calibrate without a corpus. Exact-match-after-masking is crude, but the reason string can quote
 * the shared text, and a human can confirm or dismiss it in one glance. It is also O(rows) with a
 * hash map, against O(rows²) for pairwise distance — and the cohort is bounded only by
 * `MAX_COHORT_ACCOUNTS`, so the quadratic option was never actually on the table at this budget.
 *
 * 🔴 WHAT THE MASKING BUYS AND WHAT IT COSTS. Masking links and numbers is what upgrades this from
 * "literal copy-paste" to "one template with the payload swapped", which is the actual method — the
 * link, the referral code and the amount are exactly the parts a ring varies. It also means two
 * genuinely independent people who wrote the same ordinary sentence with different numbers in it now
 * collide. `MIN_FINGERPRINT_CHARS`/`MIN_FINGERPRINT_TOKENS` are the only defence, they are set by
 * judgement, and measuring their false-positive rate is precisely what the shadow phase is for.
 *
 * 🔴 IT SEES COMMENTS ONLY. Model names, model descriptions and image prompts are all text a ring
 * could template, and none of them is read: comments are the surface shill text actually lands on,
 * they are the two tables with a `userId` index that makes the read cheap, and adding a third source
 * is a widening of `evidence.ts` rather than a change here. An account that templated only its model
 * descriptions scores 0 from this heuristic and is a KNOWN false negative, not an accident.
 *
 * 🔴 IT SEES A SAMPLE, NOT A CENSUS. The content read is budgeted (`MAX_CONTENT_SAMPLES`), so on a
 * wave day the oldest end of the cohort may not be sampled at all. An unsampled account scores 0
 * here for want of data, which — again — is not the same as scoring 0 for want of a signal. The
 * budget state rides out on `sources.contentBudgetExhausted` and as a run counter.
 */

export const CONTENT_TEMPLATING_ID = 'content-templating';

/**
 * The largest number of accounts sharing one text that is still worth nothing, and the number at
 * which the heuristic is convinced.
 *
 * `zeroAt: 2` means THREE accounts sharing one templated text is the smallest group that scores.
 * Two is a pair, and a pair of strangers writing the same masked sentence is common enough — a
 * quoted announcement, a meme, a stock phrase with a number in it — that scoring it would put the
 * heuristic straight into the noise it exists to rise above.
 */
export const CLUSTER_ZERO_AT = 2;
export const CLUSTER_ONE_AT = 10;

/** How much of the shared text the reason string quotes. Bounded because the contract caps `reason`
 *  at 2,000 characters and this clause competes with the post counts and the other two notes for
 *  that budget — an over-long quote here truncates the whole finding, not just itself. */
export const QUOTE_CHARS = 60;

/** The largest group of cohort members this account's text belongs to, with the text itself. */
export function largestContentCluster(
  userId: number,
  signals: { fingerprintsByUser: Map<number, string[]>; membersPerFingerprint: Map<string, number> }
): { size: number; fingerprint: string | null } {
  let best = { size: 0, fingerprint: null as string | null };
  for (const fingerprint of signals.fingerprintsByUser.get(userId) ?? []) {
    const size = signals.membersPerFingerprint.get(fingerprint) ?? 0;
    if (size > best.size) best = { size, fingerprint };
  }
  return best;
}

export const contentTemplatingHeuristic: BotAccountHeuristic = {
  id: CONTENT_TEMPLATING_ID,
  description:
    'How many OTHER new accounts posted the same comment text, compared after masking links and ' +
    'numbers so one template with a swapped payload still matches. Comments only, and over a ' +
    'budgeted sample of them.',
  weight: 1,
  score: ({ member, signals }) =>
    rampScore(largestContentCluster(member.userId, signals).size, CLUSTER_ZERO_AT, CLUSTER_ONE_AT),
  explain: ({ member, signals }, score) => {
    if (score <= 0) return null;
    const { size, fingerprint } = largestContentCluster(member.userId, signals);
    // The QUOTED text is the normalised form, not the raw comment: it is what was actually compared,
    // so quoting anything else would show a moderator a different string from the one the score was
    // computed on. The masks (`linkmask`, `nummask`) are visible on purpose — they are the reason
    // two superficially different comments matched.
    const quote = (fingerprint ?? '').slice(0, QUOTE_CHARS);
    return (
      `${size} new accounts posted the same text after masking links/numbers — ` +
      `“${quote}${(fingerprint ?? '').length > QUOTE_CHARS ? '…' : ''}”`
    );
  },
};
