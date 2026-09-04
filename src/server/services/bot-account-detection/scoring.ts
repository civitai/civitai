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
   * Share of the blend. Relative, not absolute: the blend divides by the total weight of the
   * heuristics that ran, so adding one does not silently dilute the others' meaning.
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
 * The blend is a weighted mean over the heuristics that RAN, so a registry of one always-zero
 * placeholder yields 0 and a registry of none yields 0 — neither of which is a claim about the
 * account.
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
 * How many of these scores each heuristic was the ONLY firing signal on.
 *
 * 🔴 THIS IS THE COUNTER THE FALSE-POSITIVE QUESTION IS ANSWERED WITH, and `fired` cannot answer it.
 * A heuristic that fires alongside the other two on the same account is corroborated; one that fires
 * BY ITSELF is carrying a finding on its own, and that is the population where a known collision
 * turns into a report nobody should have received. The worked example is `content-templating`: a
 * generation-parameter paste — `Steps: …, Sampler: …, CFG scale: …, Seed: …` — fingerprints
 * identically to the same line with different numbers, because the digit masking is doing the
 * matching, so six accounts pasting their settings under one model look like one ring. Nothing about
 * such an account fires the other two heuristics, so it lands here and nowhere else.
 *
 * Run over the REPORTED members rather than all scored ones: a sole signal below the threshold
 * produced no finding and cost nobody anything, and mixing the two would bury the number that
 * matters in the cohort's own size.
 *
 * A member on whom NOTHING fired contributes to no key, which is why these are emitted for every
 * registered heuristic including the zeros — a key that appears only when non-zero cannot be charted.
 */
export function soleSignalCounters(
  scores: BotAccountScore[],
  heuristics: readonly BotAccountHeuristic[]
): Record<string, number> {
  const counters: Record<string, number> = {};
  for (const heuristic of heuristics) counters[`heuristic:${heuristic.id}:sole_signal`] = 0;
  for (const account of scores) {
    const fired = account.subScores.filter((s) => s.score > 0);
    if (fired.length !== 1) continue;
    const key = `heuristic:${fired[0].id}:sole_signal`;
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
 * WHAT THE DEFAULT IS SET AGAINST — the blend's own arithmetic, not an intuition. With three equally
 * weighted heuristics the blend is their mean, so:
 *   - one heuristic alone at 0.45 → 0.15   (the threshold)
 *   - one heuristic alone at 1.00 → 0.33
 *   - two at 0.23 each            → 0.15
 * So 0.15 admits an account on the strength of ONE signal that is about half convinced, and rejects
 * one where every signal is weak. That is the loosest cut that still means something, chosen because
 * the shadow phase's job is to see marginal cases — a tight threshold would report only the accounts
 * nobody needed a detector to find, and would teach us nothing about where the real line sits.
 *
 * 🔴 IT IS A STARTING POINT, NOT A CALIBRATION, and nothing here pretends otherwise. No run has
 * produced a graded finding, so this number is derived from the weighting rather than from data.
 * The `confidence_bucket_*` counters below exist precisely to replace it: after a few runs the
 * distribution says where the mass actually sits, and the threshold moves to a measured value.
 * Until then the honest statement is that it is an argument, and the counters are what will settle it.
 */
export const MIN_REPORTED_CONFIDENCE = 0.15;

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
