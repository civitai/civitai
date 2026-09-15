import { unprefixFingerprint } from '../fingerprint-keys';
import type { BotAccountHeuristic } from '../scoring';
import { rampScore } from './ramp';

/**
 * HEURISTIC 3 — the same file, uploaded by accounts that are supposed to be strangers.
 *
 * WHAT IT DOES: reduce each uploaded `Image.name` to a normalised fingerprint
 * (`evidence.ts#normalizeFilename` — truncated, lowercased, whitespace collapsed), then count how
 * many DISTINCT cohort members produced each fingerprint. An account's score is the size of the
 * largest group its own uploads belong to.
 *
 * 🔴 WHY NOT A REAL SIMILARITY MEASURE. Cosine over TF-IDF, edit distance, MinHash and friends all
 * answer a better question, and all three fail the same constraint: a moderator must be able to READ
 * the reason and see why, and "similarity 0.83 to a cluster of 6" is a number nobody can check and
 * nobody can calibrate without a corpus. Exact-match-after-normalisation is crude, but the reason
 * string can quote the shared name and a human can confirm or dismiss it in one glance. It is also
 * O(rows) with a hash map, against O(rows²) for pairwise distance — and the cohort is bounded only
 * by `MAX_COHORT_ACCOUNTS`, so the quadratic option was never on the table at this budget.
 *
 * 🔴 IT USED TO SEE A SECOND SOURCE — POSTED COMMENT TEXT — AND THAT SOURCE HAS BEEN DELETED. It was
 * the ORIGINAL source; the filename half was added later, after the comment half's own production
 * record refuted it. The comment half never fired on a single account in any run it shipped in, and
 * the cause is structural rather than transient: new accounts on this site do not comment, so the
 * source has no input to find a signal in and waiting does not change that. A heuristic half with no
 * input is not a half that found nothing — it is a per-run `commentV2.findMany`, a `comment
 * .findMany`, a sample budget and four availability counters spent to learn nothing, plus a
 * normaliser, two length floors and a key namespace kept alive to support them.
 *
 * 🔴 WHAT WAS DELETED, AND WHAT DELIBERATELY WAS NOT. Gone: the text normaliser and its masking, the
 * `MIN_FINGERPRINT_CHARS`/`MIN_FINGERPRINT_TOKENS` floors, the `text:` key namespace, the whole
 * `listContentSamples` read with its budget, its availability flag and its failure flag, and the
 * `heuristic:content-templating:fired_text` counter. KEPT: this heuristic's registry entry, its
 * `content-templating` id, its weight of 1, and `heuristic:content-templating:fired_filename`. That
 * distinction is the whole safety argument for this change — the text source was one of two sources
 * INSIDE one heuristic, never a registry entry of its own, so removing it leaves
 * `BOT_ACCOUNT_HEURISTICS.length` at four and touches neither the blend denominator nor
 * `MIN_REPORTED_CONFIDENCE`, `LONE_SIGNAL_CUT` or `SOLE_SIGNAL_DOMINANCE`. Anything that moved one
 * of those would be a different change.
 *
 * 🔴 WHAT WOULD HAVE CHANGED IF A COMMENT FINGERPRINT EVER HAD MATCHED, stated because "it never
 * fired" is a claim about the input and not about the arithmetic. An account's score here is the
 * ramp over its LARGEST cluster across all sources, so deleting one source lowers a score exactly
 * when that source held the account's largest cluster: it needed at least `CLUSTER_ZERO_AT + 1`
 * distinct cohort members sharing one masked text, AND that group had to be strictly larger than
 * the account's largest shared filename. Where that held, the account's `content-templating`
 * sub-score falls to the filename ramp (possibly 0) and its blended confidence falls by the
 * difference over the registry weight — a quarter of it at four equal weights — which can drop it
 * under the reporting threshold. Nothing else moves: the other three heuristics never read this
 * index.
 *
 * 🔴 FILENAMES ARE FINGERPRINTED ON THEIR OWN TERMS — see `evidence.ts#normalizeFilename`, which
 * records why the deleted prose normaliser was measured and rejected for this surface: its digit
 * masking collapsed every `<digits>.jpg` into one key, and its length floors rejected
 * `1900.jpg.jpeg` and `logo.jpg` outright, which between them account for most of the filenames the
 * measured rings actually share.
 *
 * 🔴 WHAT IT DOES NOT SEE: comment text (now), model names, model descriptions and image prompts.
 * All are text a ring could template; none is read. An account that templated only its model
 * descriptions scores 0 from this heuristic and is a KNOWN false negative, not an accident. If one
 * of them is ever added, it is a second source folded in HERE rather than a fifth registry entry,
 * for the reason the registry note above gives: a second entry asking "did these accounts publish
 * the same string" would double that question's weight in the blend.
 *
 * 🔴 IT SEES A SAMPLE, NOT A CENSUS. The read is budgeted (`MAX_FILENAME_SAMPLES`), so on a wave day
 * the oldest end of the cohort may not be sampled at all. An unsampled account scores 0 here for
 * want of data, which is not the same as scoring 0 for want of a signal. The budget state rides out
 * on `sources.filenameBudgetExhausted` and as a run counter.
 *
 * 🔴 THE KNOWN FALSE POSITIVE IS A GENERIC NAME. There is no length floor here and no stoplist of
 * generic names, deliberately — see `normalizeFilename`, which argues that a stoplist would remove
 * precisely the filenames measured rings share, because a ring's whole method is to look
 * unremarkable. What defends against an innocent collision is `CLUSTER_ZERO_AT` plus the cohort
 * itself: at least THREE DISTINCT members, every one of them an account less than a day old.
 * `heuristic:content-templating:sole_signal` counts the findings that rest on this heuristic ALONE,
 * which is exactly the population such a collision inflates. That counter is what should set any
 * further tuning; inventing a judgement constant before it exists is the thing `evidence.ts` argues
 * against.
 */

export const CONTENT_TEMPLATING_ID = 'content-templating';

/**
 * The largest number of accounts sharing one name that is still worth nothing, and the number at
 * which the heuristic is convinced.
 *
 * `zeroAt: 2` means THREE accounts sharing one filename is the smallest group that scores. Two is a
 * pair, and a pair of strangers uploading the same ordinary name — `logo.jpg`, a camera export — is
 * common enough that scoring it would put the heuristic straight into the noise it exists to rise
 * above.
 */
export const CLUSTER_ZERO_AT = 2;
export const CLUSTER_ONE_AT = 10;

/** How much of the shared value the reason string quotes. Bounded because the contract caps `reason`
 *  at 2,000 characters and this clause competes with the post counts and the other two notes for
 *  that budget — an over-long quote here truncates the whole finding, not just itself. */
export const QUOTE_CHARS = 60;

/**
 * The largest group of cohort members this account shares a fingerprint with, and the fingerprint.
 *
 * The returned `fingerprint` is the NAMESPACED key (`file:…`), not a bare value — the caller decides
 * whether it wants the source or the display form, and `unprefixFingerprint` is what strips it.
 * Returning a bare string here would throw away the only thing that says which source produced the
 * cluster.
 *
 * `prefix` restricts the search to one source. Omitted, it searches every source, which is what the
 * score itself uses: an account is as suspicious as the largest ring it belongs to, whichever
 * surface that ring shows up on.
 *
 * 🔴 WITH ONE NAMESPACE IN THE INDEX THE TWO WALKS CANNOT RETURN DIFFERENT RESULTS. Every key is
 * `file:`-prefixed (`fingerprint-keys.ts`, pinned in `evidence.test.ts`), so the filter rejects
 * nothing and a filtered walk is the unfiltered walk. The parameter is therefore inert today and
 * the one caller that passes it — `contentTemplatingSourceScore`, behind
 * `heuristic:content-templating:fired_filename` — measures nothing the unprefixed score does not
 * already say. See that counter's note in `run.ts` for why it is kept anyway and for the trigger
 * that makes it informative again; the short version is that the namespace, not this parameter, is
 * the thing a second source needs to exist in advance.
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
 * 🔴 THE DECOMPOSITION IS THE POINT, AND `fired` CANNOT PROVIDE IT — BUT IT PROVIDES NOTHING TODAY
 * EITHER, AND BOTH HALVES OF THAT BELONG IN THE SAME SENTENCE. `heuristic:content-templating:fired`
 * does not say WHICH source fired, and the shadow phase's entire philosophy, stated in `scoring.ts`'s
 * header, is that a signal is graded on its own or not at all; without this function the filename
 * half and the comment half were permanently indistinguishable in the counters, which is how the
 * zero-firing comment half survived as long as it did. With the comment source deleted there is one
 * namespace left, so this function's only production caller returns exactly what the unprefixed
 * score returns, for every account, on every run. It is kept for the lesson rather than for a
 * measurement: the next source folded in here arrives with its own counter from its first run
 * instead of hiding inside an aggregate. See the `fired_filename` note in `run.ts`, which states the
 * equality and the trigger that ends it.
 *
 * 🔴 THE PER-SOURCE COUNTERS MAY SUM TO MORE THAN `fired`, DELIBERATELY — A RULE FOR THE SECOND
 * SOURCE, NOT A DESCRIPTION OF ANY RUN THAT HAS HAPPENED. An account scoring from two sources counts
 * in both, because the alternative — attributing it to whichever source happened to win a `>`
 * comparison — invents a tie-break the data does not support and would report a real double signal
 * as a single one. They are independent questions ("did the filename half fire on this account")
 * rather than a partition of one. At one source the sum cannot exceed `fired`; it equals it.
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
    'How many OTHER new accounts uploaded a file under the same name, compared case-insensitively. ' +
    'Over a budgeted sample.',
  weight: 1,
  score: ({ member, signals }) =>
    rampScore(largestContentCluster(member.userId, signals).size, CLUSTER_ZERO_AT, CLUSTER_ONE_AT),
  explain: ({ member, signals }, score) => {
    if (score <= 0) return null;
    const { size, fingerprint } = largestContentCluster(member.userId, signals);
    // 🔴 THE PREFIX IS STRIPPED BEFORE A HUMAN SEES IT. The namespace exists so the index can carry
    // more than one source; it is an implementation detail of the index, and a moderator reading
    // “file:logo.jpg” would reasonably conclude the account uploaded a file called `file:logo.jpg`.
    // The QUOTED value is otherwise exactly what was compared.
    const value = unprefixFingerprint(fingerprint ?? '');
    const quote = value.slice(0, QUOTE_CHARS);
    const ellipsis = value.length > QUOTE_CHARS ? '…' : '';
    return `${size} new accounts uploaded a file with the same name — “${quote}${ellipsis}”`;
  },
};
