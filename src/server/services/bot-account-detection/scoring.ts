import type { BotAccountCohortMember } from './cohort';
import type { CohortSignals } from './evidence';

/**
 * The scoring seam.
 *
 * Why a registry of independent sub-scores rather than one `score(member)` function: shadow mode is
 * not a dry run of the blend, it is a grading harness for each heuristic ON ITS OWN. A signal that
 * fires on 90% of a day's new accounts is useless whatever the blend does with it, and that is only
 * visible if every heuristic's own number reaches the board. So each contributes a separately
 * reportable value, the blend is derived from those rather than the other way round, and the
 * per-heuristic counters go out with every report.
 *
 * The registry itself lives in `heuristics/index.ts`, not here — this file owns the MECHANICS
 * (clamping, blending, counting, the reporting threshold) and knows nothing about what any
 * particular heuristic measures.
 */

/**
 * Everything a heuristic is allowed to look at.
 *
 * A parameter object rather than a bare member precisely so a heuristic needing a second source is
 * added by widening this type ONCE. That is what happened: `signals` is that widening, and every
 * heuristic signature was untouched by it.
 */
export type BotAccountEvidence = {
  member: BotAccountCohortMember;
  /** The run's clock, so a heuristic never reaches for `new Date()` and becomes untestable. */
  now: Date;
  /**
   * The cohort-level indexes — who else registered on this IP, who else posted this text.
   *
   * 🔴 IT CARRIES ITS OWN AVAILABILITY (`signals.sources`), and a heuristic reading a count out of
   * it is expected to consult that before treating a zero as a finding. An empty index means "no
   * cluster" OR "the source was down", and those two are not the same claim.
   */
  signals: CohortSignals;
};

export type BotAccountHeuristic = {
  /**
   * Stable opaque key. It is a counters key and a board-facing sub-score name, so it is an
   * identifier and not a sentence — renaming one renames a metric.
   */
  id: string;
  /** What it claims to detect, for the humans reading a report. Never parsed. */
  description: string;
  /**
   * Share of the blend, against the WHOLE REGISTRY — so adding a heuristic DOES dilute every other
   * one's contribution, and the arithmetic is stated here because the next author to add one reads
   * this field before they read anything else.
   *
   * 🔴 THIS DOCSTRING SAID THE OPPOSITE UNTIL A FOURTH HEURISTIC WAS ADDED. It read: "Relative, not
   * absolute: the blend divides by the total weight of the heuristics that RAN, so adding one does
   * not silently dilute the others' meaning." That was wrong, it contradicted `scoreAccount` in this
   * same file — which had already been corrected once and records the correction — and it was wrong
   * in the most expensive direction available: it told the one person in a position to cause the
   * dilution that the dilution cannot happen.
   *
   * What the code does: `scoreAccount` divides by `Σ weight` over EVERY REGISTERED heuristic, not
   * over the ones that had input. So with `n` equally-weighted heuristics a lone signal of `s`
   * blends to `s / n`, and registering an `n + 1`th multiplies every existing account's confidence
   * by `n / (n + 1)` — 25% off the top of all of them when a third registry becomes a fourth. That
   * is DELIBERATE (see `scoreAccount` for why a blend must not silently rescale itself when a source
   * is down) and it has a consequence that is not: `MIN_REPORTED_CONFIDENCE` is a literal, so an
   * unchanged threshold against a larger denominator is a quietly stricter detector nobody decided
   * on. Adding a heuristic means re-deriving that constant in the same change. There is a guard —
   * see `LONE_SIGNAL_CUT`.
   */
  weight: number;
  /** 0..1. Out-of-range and non-finite values are clamped and COUNTED — see `scoreAccount`. */
  score: (evidence: BotAccountEvidence) => number;
  /**
   * The evidence-citing clause for the score just produced, or `null` to say nothing. Returning
   * `null` at zero is the normal case: a report whose reason recites every heuristic that did not
   * fire is unreadable, and the sub-scores carry that information already.
   */
  explain: (evidence: BotAccountEvidence, score: number) => string | null;
};

/** One heuristic's verdict on one account. */
export type HeuristicScore = {
  id: string;
  score: number;
  weight: number;
  note: string | null;
  /** The heuristic returned something outside 0..1 or non-finite, and it was clamped. */
  clamped: boolean;
};

export type BotAccountScore = {
  userId: number;
  /** The weighted blend, 0..1. The producer's own confidence — not comparable with another
   *  detector's, which is why the wire contract says so too. */
  confidence: number;
  subScores: HeuristicScore[];
};

/**
 * 🔴 THE PLACEHOLDER, NO LONGER REGISTERED. It returns 0 for every account and explains nothing.
 *
 * It shipped as the sole member of the registry so that the seam was exercised on a real run before
 * any heuristic existed. It is NOT in `BOT_ACCOUNT_HEURISTICS` any more — `heuristics/index.ts` now
 * holds the three real ones — and it is kept only because the registry-mechanics tests need an inert
 * heuristic to exercise blending and counting with, independently of what any real one measures.
 *
 * It is not a baseline, a prior, or a floor, and no calibration may be derived from it.
 */
export const placeholderHeuristic: BotAccountHeuristic = {
  id: 'placeholder-no-op',
  description:
    'Placeholder. Scores every account 0 and detects nothing. Not registered; kept for tests only.',
  weight: 1,
  score: () => 0,
  explain: () => null,
};

/**
 * Force one heuristic's return value into the contract.
 *
 * A heuristic is ordinary code and can return `NaN`, `Infinity` or 1.4 — and the wire schema
 * `.max(1)`s confidence, so an unclamped value 400s the whole report and loses every finding in the
 * batch, not just the offending one. Clamping is therefore the only safe direction; the `clamped`
 * flag is what stops it being silent.
 */
function clampScore(raw: number): { score: number; clamped: boolean } {
  // 🔴 Non-finite goes to 0, NOT to the nearest bound. `Infinity` is a defect in the heuristic — a
  // divide by zero, an empty denominator — and not a maximal opinion about the account. Clamping it
  // to 1 would put a top-confidence finding in front of a moderator on the strength of a bug, which
  // is the one direction a shadow-mode detector must not fail in.
  if (!Number.isFinite(raw)) return { score: 0, clamped: true };
  if (raw < 0) return { score: 0, clamped: true };
  if (raw > 1) return { score: 1, clamped: true };
  return { score: raw, clamped: false };
}

/**
 * Run every heuristic over one account.
 *
 * 🔴 THE BLEND DIVIDES BY EVERY REGISTERED WEIGHT, NOT BY THE HEURISTICS THAT HAD INPUT — and this
 * docstring claimed the opposite ("a weighted mean over the heuristics that RAN") until a heuristic
 * with no input made the difference matter. The denominator below is `subScores.reduce(…weight…)`
 * over the whole registry; a heuristic whose source was empty contributes 0 to the numerator and
 * its full weight to the denominator. So a permanently silent third of an equally-weighted registry
 * of three is not neutral — it is a fixed 1/3 haircut that caps every account at 0.667, which is
 * exactly what a `registration-cluster` score of 0.6667 blending to 0.2222 records.
 *
 * That is a DELIBERATE choice and not a defect to be patched here: dividing by only the heuristics
 * that found data would make an account's confidence depend on which sources happened to be up,
 * so the same account would score differently on a day ClickHouse was down — and `sources` exists
 * precisely so a grading pass can exclude those runs rather than have the blend silently rescale
 * itself. But the arithmetic has to be stated correctly, because the next person to touch the
 * denominator will read this sentence first.
 *
 * A registry of one always-zero placeholder still yields 0, and a registry of none yields 0 —
 * neither of which is a claim about the account.
 */
export function scoreAccount(
  heuristics: readonly BotAccountHeuristic[],
  evidence: BotAccountEvidence
): BotAccountScore {
  const subScores: HeuristicScore[] = heuristics.map((h) => {
    const { score, clamped } = clampScore(h.score(evidence));
    return { id: h.id, score, weight: h.weight, note: h.explain(evidence, score), clamped };
  });

  const totalWeight = subScores.reduce((sum, s) => sum + (s.weight > 0 ? s.weight : 0), 0);
  const weighted = subScores.reduce((sum, s) => sum + (s.weight > 0 ? s.weight * s.score : 0), 0);
  // A zero total weight is not an error: it is what a registry of zero heuristics, or of
  // deliberately disabled ones, looks like. Dividing would be NaN, and NaN reaches the wire schema
  // as a rejected report.
  const confidence = totalWeight > 0 ? clampScore(weighted / totalWeight).score : 0;

  return { userId: evidence.member.userId, confidence, subScores };
}

/**
 * The per-heuristic counters that ride out with every report.
 *
 * Three numbers per heuristic, not one, because the question shadow mode asks is "how often does
 * this fire, and how hard" — `fired` alone cannot distinguish a signal that never triggers from one
 * that triggers weakly on everything.
 *
 * The `heuristic:` prefix keeps them from colliding with the run-level counters in the same flat
 * record; a heuristic id containing a colon would read ambiguously, which is why ids are identifiers.
 */
export function heuristicCounters(scores: BotAccountScore[]): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const account of scores) {
    for (const sub of account.subScores) {
      const evaluated = `heuristic:${sub.id}:evaluated`;
      const fired = `heuristic:${sub.id}:fired`;
      const clamped = `heuristic:${sub.id}:clamped`;
      counters[evaluated] = (counters[evaluated] ?? 0) + 1;
      counters[fired] = (counters[fired] ?? 0) + (sub.score > 0 ? 1 : 0);
      counters[clamped] = (counters[clamped] ?? 0) + (sub.clamped ? 1 : 0);
    }
  }
  return counters;
}

/**
 * How much larger than every other score a heuristic's own must be before the finding counts as
 * carried by it alone.
 *
 * 🔴 COMPUTED FROM THE REGISTRY'S SIZE, NOT PICKED — AND IT USED TO BE A LITERAL `3` THAT ONLY
 * HAPPENED TO EQUAL IT. With `n` equally weighted heuristics and a top score `s`, every other is at
 * most `s / k`, so the rest together contribute at most `(n - 1) · s / k` — which is less than `s`
 * exactly when `k > n - 1`. The smallest integer satisfying that is `n` itself. At `n = 3` that is
 * 3, which is why the literal was invisible; at `n = 4` it is 4, and the literal would have kept
 * calling a finding "sole" that two heuristics between them outweighed.
 *
 * Its own docstring said to re-derive it by hand when `heuristics/index.ts` grew. Doing the
 * derivation IN CODE is strictly better than a note asking the next person to remember: a constant
 * that must be edited in step with another file is a defect waiting for the edit that forgets, and
 * this one was already one registry-entry away from firing. At `n = 3` the value is unchanged, so
 * this closes the class without moving any counter today.
 *
 * `n = 0` cannot occur through `soleSignalCounters` (no heuristics means no counters and no leader),
 * and `n = 1` gives `k = 1`, which is correct: a registry of one has no runner-up, so `s >= 1 × 0`
 * counts every firing as sole. The floor is what keeps a degenerate `n` from producing `k = 0`,
 * where `s >= 0` would make EVERY finding sole including ones two heuristics agreed on.
 */
export const soleSignalDominance = (registrySize: number): number => Math.max(1, registrySize);

/**
 * How many of these scores each heuristic CARRIED ON ITS OWN.
 *
 * 🔴 THIS IS THE COUNTER THE FALSE-POSITIVE QUESTION IS ANSWERED WITH, and `fired` cannot answer it.
 * A heuristic that fires alongside the other two on the same account is corroborated; one that
 * carries a finding by itself is the population where a known collision turns into a report nobody
 * should have received. The worked example is `content-templating`: a generation-parameter paste —
 * `Steps: …, Sampler: …, CFG scale: …, Seed: …` — fingerprints identically to the same line with
 * different numbers, because the digit masking is doing the matching, so six accounts pasting their
 * settings under one model look like one ring.
 *
 * 🔴 "CARRIED IT" IS A DOMINANCE TEST, NOT AN EXCLUSIVITY TEST, AND THE DIFFERENCE IS THE WHOLE
 * POINT OF THE COUNTER. The predicate used to be `exactly one heuristic scored above zero`, and that
 * measured a strictly smaller population than the sentence above describes: the collision's own
 * routine shape is a member who ALSO scores a trace somewhere else, and a trace excluded it. A
 * member 40 minutes old with 6 parameter-paste comments and a fingerprint cluster of 6 scores
 * `posting-velocity` 0.1389 — six items in 0.67h is 9/hour, just over the 4/hour floor — and
 * `content-templating` 0.5. It clears `MIN_REPORTED_CONFIDENCE`, is REPORTED, and under the old
 * predicate incremented nothing. An operator reading `content-templating:sole_signal = 0` concluded
 * the collision produced no reports, on the one number the decision about that collision was
 * deferred to, and the error ran in the reassuring direction. The dominance form counts it, at a
 * three-heuristic registry: 0.5 ≥ 3 × 0.1389.
 *
 * 🔴 AND AT FOUR IT DOES NOT — 4 × 0.1389 is 0.5556, above the 0.5 that carried it. That is the
 * derivation working rather than failing: with a fourth heuristic registered there is one more place
 * for an unseen contribution to hide, so the bar for "outweighs everything else combined" is higher
 * and this member is no longer on the safe side of it. The consequence is real and worth knowing
 * before reading the counter: the SAME account, scored by a larger registry, moves out of the
 * sole-signal population and into the corroborated one, so a drop in this counter across the change
 * that added `asset-staging` is the bar moving and not the collision going away.
 *
 * Two signals that genuinely agree still count for neither. At any multiple above 1 a tie fails the
 * test — `0.9 ≥ 3 × 0.9` is false — so corroboration is excluded by the arithmetic rather than by a
 * special case.
 *
 * Run over the REPORTED members rather than all scored ones: a sole signal below the threshold
 * produced no finding and cost nobody anything, and mixing the two would bury the number that
 * matters in the cohort's own size.
 *
 * A member on whom NOTHING fired contributes to no key, which is why these are emitted for every
 * registered heuristic including the zeros — a key that appears only when non-zero cannot be charted.
 *
 * The key keeps the name `sole_signal` even though the predicate moved. It is a metric name, and
 * the question it answers — which heuristic carried this finding — is the same one; the change is
 * that it now measures the population that question names instead of a subset of it. Nothing has
 * consumed the key yet, so no series breaks either way, and renaming costs every reader of the
 * design notes a lookup for no gain in what the number means.
 */
export function soleSignalCounters(
  scores: BotAccountScore[],
  heuristics: readonly BotAccountHeuristic[]
): Record<string, number> {
  const counters: Record<string, number> = {};
  // The bar is a function of how many heuristics were REGISTERED for this run, not of how many
  // fired: the derivation bounds what the non-leaders could contribute, and a heuristic that scored
  // 0 is a non-leader contributing 0. Taken from the argument rather than from a module constant so
  // a run with an injected registry is graded against its own size.
  const dominance = soleSignalDominance(heuristics.length);
  for (const heuristic of heuristics) counters[`heuristic:${heuristic.id}:sole_signal`] = 0;
  for (const account of scores) {
    // The leading score, and the largest of everything else. A registry of one leaves the runner-up
    // at 0, which is what makes a single-heuristic run count — there is nothing for it to share the
    // finding with.
    let leader: HeuristicScore | null = null;
    let runnerUp = 0;
    for (const sub of account.subScores) {
      if (leader === null || sub.score > leader.score) {
        if (leader !== null) runnerUp = Math.max(runnerUp, leader.score);
        leader = sub;
      } else {
        runnerUp = Math.max(runnerUp, sub.score);
      }
    }
    if (leader === null || leader.score <= 0) continue;
    if (leader.score < dominance * runnerUp) continue;
    const key = `heuristic:${leader.id}:sole_signal`;
    counters[key] = (counters[key] ?? 0) + 1;
  }
  return counters;
}

/** The compact `id=0.00` rendering the finding's reason carries, so a moderator sees each
 *  heuristic's own number rather than only the blend. */
export function renderSubScores(subScores: HeuristicScore[]): string {
  if (!subScores.length) return 'no heuristics registered';
  return subScores.map((s) => `${s.id}=${s.score.toFixed(2)}`).join(', ');
}

/**
 * The evidence-citing clauses, in one string a moderator can act on.
 *
 * 🔴 THE NOTES WERE COLLECTED AND THEN DROPPED. `HeuristicScore.note` has always existed and every
 * heuristic has always been asked to produce one, but the finding's reason rendered only
 * `renderSubScores` — the bare `id=0.00` list. So the board carried three numbers and no statement
 * of what any of them SAW, which is the half a moderator needs to decide anything. With a
 * do-nothing placeholder as the only heuristic that gap was invisible, because the only note was
 * always `null`.
 *
 * Heuristics that scored 0 return `null` and contribute nothing here, deliberately: a reason that
 * recites every signal that did not fire buries the one that did.
 */
export function renderNotes(subScores: HeuristicScore[]): string | null {
  const notes = subScores.flatMap((s) => (s.note ? [`${s.id}: ${s.note}`] : []));
  return notes.length ? notes.join(' | ') : null;
}

/**
 * 🔴 THE REPORTING THRESHOLD. WITHOUT IT THE DETECTOR CANNOT HAVE A REAL RUN.
 *
 * `run.ts` turned every cohort member into a finding with no confidence filter anywhere. With a
 * do-nothing placeholder that was harmless — every finding was confidence 0 and the run was never
 * meant to be looked at. With three real heuristics it is not: a day's posting cohort would land on
 * a live moderator board in front of the whole abuse team, batched across up to ten reports, almost
 * entirely as confidence-0 rows. A board that is mostly noise on its first day is a board nobody
 * reads on its second, and that failure is not recoverable by tuning later.
 *
 * WHAT THE DEFAULT IS SET AGAINST — the blend's own arithmetic, not an intuition. With `n` equally
 * weighted heuristics the blend is their mean, so the cut is `LONE_SIGNAL_CUT / n`. At the current
 * `n = 4`, i.e. 0.1125:
 *   - one heuristic alone at 0.45 → 0.1125  (the threshold)
 *   - one heuristic alone at 1.00 → 0.25
 *   - two at 0.225 each           → 0.1125
 * So it admits an account on the strength of ONE signal that is about half convinced, and rejects
 * one where every signal is weak. That is the loosest cut that still means something, chosen because
 * the shadow phase's job is to see marginal cases — a tight threshold would report only the accounts
 * nobody needed a detector to find, and would teach us nothing about where the real line sits.
 *
 * 🔴 IT WAS `0.15` AT `n = 3` AND IT IS `0.1125` AT `n = 4`, AND THE CHANGE IS THE WHOLE POINT. A
 * fourth registered heuristic divides every existing account's confidence by 4 instead of 3 — a flat
 * 25% haircut — while a literal threshold stays exactly where it is. Left at 0.15 the cut would have
 * gone on admitting only a signal 0.6 convinced: a tighter detector nobody decided on, arrived at by
 * not editing a file. Concretely, every account whose confidence sat in [0.15, 0.20) — a lone
 * heuristic between 0.45 and 0.60, or any combination summing there — would have vanished from the
 * board with no counter recording it, because `findings_suppressed` counts members below the cut and
 * cannot say the cut moved underneath them. Re-deriving keeps the REPORTED POPULATION unchanged for
 * every account the new heuristic scores 0 on, which is the only honest way to add a signal: strictly
 * additive, never quietly subtractive.
 *
 * 🔴 IT IS STILL A LITERAL AND STILL NOT COMPUTED FROM THE REGISTRY, deliberately — `scoring.ts`
 * owns the mechanics and knows nothing about which heuristics exist, and importing the registry here
 * to read its length would invert that. What closes the gap instead is `LONE_SIGNAL_CUT` below plus
 * the guard in `__tests__/scoring.test.ts`, which multiplies this constant by the registry's actual
 * length and fails unless the product is the lone-signal sub-score. A fifth heuristic added without
 * re-deriving this value now fails a test with the arithmetic in its name. (The older guards —
 * `1/n > this` and `0.4/n < this` — hold at every `n` this will plausibly reach and would NOT have
 * caught it; they are kept as sanity bounds, not as the guard.)
 *
 * 🔴 IT IS A STARTING POINT, NOT A CALIBRATION, and nothing here pretends otherwise. No run has
 * produced a graded finding, so this number is derived from the weighting rather than from data.
 * The `confidence_bucket_*` counters below exist precisely to replace it: after a few runs the
 * distribution says where the mass actually sits, and the threshold moves to a measured value.
 * Until then the honest statement is that it is an argument, and the counters are what will settle it.
 */
export const MIN_REPORTED_CONFIDENCE = 0.1125;

/**
 * The SUB-SCORE one heuristic must reach ON ITS OWN for its account to be reported.
 *
 * 🔴 THIS IS THE NUMBER THAT WAS NEVER WRITTEN DOWN, AND ITS ABSENCE IS WHY THE THRESHOLD COULD GO
 * STALE. The reporting cut has always been an argument about a lone signal — "about half convinced"
 * — divided by the registry's size. Only the quotient existed as a constant, so the registry could
 * grow underneath it and nothing was left to compare against: `0.15` is not wrong-looking at `n = 4`,
 * it is just a different claim about how convinced a lone signal must be, made by nobody.
 *
 * Naming the invariant half separately makes the relationship checkable —
 * `MIN_REPORTED_CONFIDENCE × registry size === LONE_SIGNAL_CUT` — which is exactly what
 * `__tests__/scoring.test.ts` asserts. This is the constant that carries the JUDGEMENT; the
 * threshold is arithmetic on it.
 *
 * It is still a judgement and not a measurement, for the reason `MIN_REPORTED_CONFIDENCE` gives at
 * length: no run has produced a graded finding yet, and the `confidence_bucket_*` counters are what
 * will replace it.
 */
export const LONE_SIGNAL_CUT = 0.45;

/**
 * How many buckets the confidence distribution is reported in.
 *
 * Ten, i.e. tenths. Coarse on purpose: the counters are a shape, not a histogram to do statistics
 * on, and a wide bucket cannot be reversed into any individual account's score — which matters
 * because these ride out on every report whether or not the account produced a finding.
 */
export const CONFIDENCE_BUCKETS = 10;

/** The counter key for one bucket — `confidence_bucket_20_30` is `0.2 <= c < 0.3`, in percent so
 *  the key is an identifier with no decimal point in it. */
export const confidenceBucketKey = (index: number): string =>
  `confidence_bucket_${index * 10}_${(index + 1) * 10}`;

/**
 * Which bucket a confidence falls in.
 *
 * 🔴 THE TOP BUCKET IS CLOSED AT BOTH ENDS. Every other bucket is half-open, but `1.0` is a real and
 * meaningful score — it is what a fully convinced heuristic produces — and a naive `floor(c * 10)`
 * puts it in an eleventh bucket that no key exists for, silently dropping the most interesting
 * accounts in the run out of the distribution entirely. Clamping is what keeps the buckets summing
 * to the number scored.
 */
export function confidenceBucket(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0;
  const clamped = Math.min(Math.max(confidence, 0), 1);
  return Math.min(CONFIDENCE_BUCKETS - 1, Math.floor(clamped * CONFIDENCE_BUCKETS));
}

/**
 * 🔴 THE DISTRIBUTION OF EVERY MEMBER SCORED, REPORTED OR NOT.
 *
 * This is the counterweight to the threshold and the reason the threshold is safe to add. A member
 * dropped below the cut produces no finding, so nothing on the board mentions it — and the whole
 * point of shadow mode is grading the heuristics, which cannot be done over a population that was
 * silently discarded. A run reporting "12 findings" while the whole rest of the cohort scored 0 is a
 * reassuring number that hides the only fact worth knowing about that run.
 *
 * So: every bucket is emitted on every run, INCLUDING the empty ones. A counter that appears only
 * when non-zero cannot be charted or alerted on, because its absence is indistinguishable from the
 * producer not having run — the same reasoning `cohort_capped` is emitted as 0/1 for.
 */
export function confidenceBucketCounters(scores: BotAccountScore[]): Record<string, number> {
  const counters: Record<string, number> = {};
  for (let i = 0; i < CONFIDENCE_BUCKETS; i += 1) counters[confidenceBucketKey(i)] = 0;
  for (const score of scores)
    counters[confidenceBucketKey(confidenceBucket(score.confidence))] += 1;
  return counters;
}

/**
 * Split the scored cohort at the threshold.
 *
 * `>=`, so a score exactly equal to the threshold IS reported. The alternative reading makes the
 * constant's name a lie — a "minimum reported confidence" that is itself not reported — and the
 * off-by-one would be invisible in the counters, which is the worst place for one to hide.
 *
 * Both halves come back. The caller needs the suppressed side to count it, not merely to discard it.
 */
export function partitionByConfidence(
  scores: BotAccountScore[],
  minConfidence: number
): { reported: BotAccountScore[]; suppressed: BotAccountScore[] } {
  const reported: BotAccountScore[] = [];
  const suppressed: BotAccountScore[] = [];
  for (const score of scores)
    (score.confidence >= minConfidence ? reported : suppressed).push(score);
  return { reported, suppressed };
}
