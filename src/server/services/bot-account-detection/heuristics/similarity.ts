import { FILENAME_FINGERPRINT_PREFIX, unprefixFingerprint } from '../fingerprint-keys';
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
 * 🔴 IT SEES TWO SOURCES: COMMENT TEXT AND UPLOADED FILENAMES. It used to see comments only, and
 * that limitation is what this heuristic's own production record refuted. Across five runs the
 * comment half fired ZERO times — not because rings do not template, but because new accounts on
 * this site do not comment: three consecutive daily cohorts totalling roughly 25,000 new accounts
 * produced 65 comments between them, and one entire run's content input was 4 rows from 3 accounts.
 * A heuristic with no input is not a heuristic that found nothing, and because the blend divides by
 * every REGISTERED weight rather than by the ones that ran, a permanently silent third of the
 * registry also capped every account's confidence at 0.667.
 *
 * `Image.name` is the second fingerprint source, folded in HERE rather than added as a fourth
 * heuristic. That is a deliberate constraint, not a convenience: `MIN_REPORTED_CONFIDENCE` is
 * derived from the registry's size in `scoring.ts`, as is `SOLE_SIGNAL_DOMINANCE`, so a fourth
 * entry would silently move the reporting threshold for every other signal. Keeping the registry at
 * three is what makes this a widening of one heuristic's evidence rather than a recalibration of
 * the whole detector.
 *
 * 🔴 FILENAMES ARE FINGERPRINTED ON THEIR OWN TERMS — see `evidence.ts#normalizeFilename`. Reusing
 * `contentFingerprint` was measured and rejected: its digit masking collapses every `<digits>.jpg`
 * into one key, and its length floors reject `1900.jpg.jpeg` and `logo.jpg` outright, which between
 * them account for most of the filenames the measured rings actually share.
 *
 * 🔴 WHAT IT STILL DOES NOT SEE: model names, model descriptions and image prompts. All are text a
 * ring could template; none is read. An account that templated only its model descriptions scores 0
 * from this heuristic and is a KNOWN false negative, not an accident.
 *
 * 🔴 IT SEES A SAMPLE, NOT A CENSUS. Both reads are budgeted (`MAX_CONTENT_SAMPLES`,
 * `MAX_FILENAME_SAMPLES`), so on a wave day the oldest end of the cohort may not be sampled at all.
 * An unsampled account scores 0 here for want of data, which — again — is not the same as scoring 0
 * for want of a signal. The budget state rides out on `sources.contentBudgetExhausted` /
 * `sources.filenameBudgetExhausted` and as run counters, and the two sources carry SEPARATE flags
 * because they fail separately.
 *
 * 🔴 THE KNOWN FALSE POSITIVE, NAMED, MEASURED AND DELIBERATELY NOT PATCHED: A GENERATION-PARAMETER
 * PASTE. `Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1234567890, Size: 512x768` and the same
 * line with entirely different numbers produce an IDENTICAL fingerprint, because every number is a
 * `nummask` — verified by executing the shipped normaliser, and pinned as a regression case in
 * `__tests__/evidence.test.ts` so it cannot quietly stop being true. Pasting settings under a model
 * is one of the most ordinary comments on this site, so six such accounts in one day's cohort read
 * as a ring of six and are reported. `MIN_FINGERPRINT_CHARS`/`MIN_FINGERPRINT_TOKENS` defend against
 * SHORT text only and cannot reach this by construction.
 *
 * TWO FIXES WERE CONSIDERED AND BOTH REJECTED ON THE ARITHMETIC, not on taste:
 *  - DISCARD FINGERPRINTS THAT ARE MOSTLY MASK TOKENS. Measured on the shipped normaliser, the two
 *    classes do not sit close — they INTERLEAVE, in both directions, so no threshold exists in
 *    either. A paste that includes the prompt (the commonest real form) is 6/21 masks and
 *    `check out linkmask for nummask free buzz` is 2/7 — the SAME value, 0.286. And the ordering
 *    inverts at the other end: `free buzz linkmask nummask` is 0.500, above the longest parameter
 *    paste's 0.389. A cut low enough to catch pastes discards shill text first; a cut high enough
 *    to spare shill text catches nothing. The arithmetic is asserted in `__tests__/evidence.test.ts`
 *    rather than left as a claim here.
 *  - RAISE `CLUSTER_ZERO_AT`. It does not remove the class, it only demands a larger innocent
 *    cluster — and the innocent cluster here is "people who commented their settings under a
 *    popular model today", which is not bounded by anything. A floor high enough to exclude it
 *    would also exclude most real rings.
 * So the honest disposition is the shadow phase's own: the collision is REPORTED rather than
 * silently tuned away, the reason string QUOTES the normalised text that clustered — so a
 * generation-parameter paste identifies itself to a moderator in one glance, which is a property of
 * the design rather than a hope — and `heuristic:content-templating:sole_signal` counts the
 * findings that rest on this heuristic ALONE, which is exactly the population a collision inflates.
 * That counter is what should set the fix, and inventing a third judgement constant before it exists
 * is the thing `evidence.ts` argues against at `MIN_FINGERPRINT_CHARS`.
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

/**
 * The largest group of cohort members this account shares a fingerprint with, and the fingerprint.
 *
 * The returned `fingerprint` is the NAMESPACED key (`text:…` / `file:…`), not a bare value — the
 * caller decides whether it wants the source or the display form, and `unprefixFingerprint` is what
 * strips it. Returning a bare string here would throw away the only thing that says which source
 * produced the cluster.
 *
 * `prefix` restricts the search to one source. Omitted, it searches both, which is what the score
 * itself uses: an account is as suspicious as the largest ring it belongs to, whichever surface
 * that ring shows up on.
 */
export function largestContentCluster(
  userId: number,
  signals: {
    fingerprintsByUser: Map<number, string[]>;
    membersPerFingerprint: Map<string, number>;
  },
  prefix?: string
): { size: number; fingerprint: string | null } {
  let best = { size: 0, fingerprint: null as string | null };
  for (const fingerprint of signals.fingerprintsByUser.get(userId) ?? []) {
    if (prefix !== undefined && !fingerprint.startsWith(prefix)) continue;
    const size = signals.membersPerFingerprint.get(fingerprint) ?? 0;
    if (size > best.size) best = { size, fingerprint };
  }
  return best;
}

/**
 * This account's score from ONE source alone.
 *
 * 🔴 THE DECOMPOSITION IS THE POINT, AND `fired` CANNOT PROVIDE IT. With two sources behind one
 * heuristic id, `heuristic:content-templating:fired` no longer says WHICH source fired — and the
 * shadow phase's entire philosophy, stated in `scoring.ts`'s header, is that a signal is graded on
 * its own or not at all. Without this the filename half and the comment half would be permanently
 * indistinguishable in the counters, which is how the zero-firing comment half survived five runs.
 *
 * 🔴 THE PER-SOURCE COUNTERS MAY SUM TO MORE THAN `fired`, DELIBERATELY. An account whose text AND
 * whose filenames both cluster counts in both, because the alternative — attributing it to
 * whichever source happened to win a `>` comparison — invents a tie-break the data does not
 * support and would report a real double signal as a single one. They are two independent questions
 * ("did the filename half fire on this account") rather than a partition of one.
 */
export function contentTemplatingSourceScore(
  userId: number,
  signals: {
    fingerprintsByUser: Map<number, string[]>;
    membersPerFingerprint: Map<string, number>;
  },
  prefix: string
): number {
  return rampScore(
    largestContentCluster(userId, signals, prefix).size,
    CLUSTER_ZERO_AT,
    CLUSTER_ONE_AT
  );
}

export const contentTemplatingHeuristic: BotAccountHeuristic = {
  id: CONTENT_TEMPLATING_ID,
  description:
    'How many OTHER new accounts shared the same comment text — compared after masking links and ' +
    'numbers so one template with a swapped payload still matches — or uploaded a file under the ' +
    'same name, compared case-insensitively. Over a budgeted sample of each.',
  weight: 1,
  score: ({ member, signals }) =>
    rampScore(largestContentCluster(member.userId, signals).size, CLUSTER_ZERO_AT, CLUSTER_ONE_AT),
  explain: ({ member, signals }, score) => {
    if (score <= 0) return null;
    const { size, fingerprint } = largestContentCluster(member.userId, signals);
    const isFilename = (fingerprint ?? '').startsWith(FILENAME_FINGERPRINT_PREFIX);
    // 🔴 THE PREFIX IS STRIPPED BEFORE A HUMAN SEES IT. The namespace exists so two sources can
    // share one map; it is an implementation detail of the index, and a moderator reading
    // “file:logo.jpg” would reasonably conclude the account uploaded a file called `file:logo.jpg`.
    // The QUOTED value is otherwise exactly what was compared — for text that is the normalised
    // form, masks (`linkmask`, `nummask`) visible on purpose, because they are the reason two
    // superficially different comments matched.
    const value = unprefixFingerprint(fingerprint ?? '');
    const quote = value.slice(0, QUOTE_CHARS);
    const ellipsis = value.length > QUOTE_CHARS ? '…' : '';
    return isFilename
      ? `${size} new accounts uploaded a file with the same name — “${quote}${ellipsis}”`
      : `${size} new accounts posted the same text after masking links/numbers — ` +
          `“${quote}${ellipsis}”`;
  },
};
