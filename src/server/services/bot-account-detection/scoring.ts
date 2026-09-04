import type { BotAccountCohortMember } from './cohort';

/**
 * The scoring seam. NO DETECTION LIVES HERE YET, and that is the deliverable rather than an omission
 * — the heuristics are a separate change, and inventing some to fill the shape out would be
 * inventing exactly the thing the shadow phase exists to measure.
 *
 * Why a registry of independent sub-scores rather than one `score(member)` function: shadow mode is
 * not a dry run of the blend, it is a grading harness for each heuristic ON ITS OWN. A signal that
 * fires on 90% of a day's new accounts is useless whatever the blend does with it, and that is only
 * visible if every heuristic's own number reaches the board. So each contributes a separately
 * reportable value, the blend is derived from those rather than the other way round, and the
 * per-heuristic counters go out with every report.
 */

/** Everything a heuristic is allowed to look at. A parameter object rather than a bare member so a
 *  heuristic that needs a second source (ClickHouse events, registration IPs) is added by widening
 *  this type once, not by changing every signature. */
export type BotAccountEvidence = {
  member: BotAccountCohortMember;
  /** The run's clock, so a heuristic never reaches for `new Date()` and becomes untestable. */
  now: Date;
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
 * 🔴 THE PLACEHOLDER. It detects nothing, by construction: it returns 0 for every account and
 * explains nothing.
 *
 * It exists so the registry is exercised on a real run — an empty array makes every loop, every
 * counter and every blend vacuous, and a seam that has never had anything in it is not a seam that
 * has been shown to work. Delete it in the change that adds the first real heuristic; it is not a
 * baseline, a prior, or a floor, and no calibration should ever be derived from it.
 */
export const placeholderHeuristic: BotAccountHeuristic = {
  id: 'placeholder-no-op',
  description:
    'Placeholder. Scores every account 0 and detects nothing. Remove with the first real heuristic.',
  weight: 1,
  score: () => 0,
  explain: () => null,
};

/** The heuristics a production run uses. */
export const BOT_ACCOUNT_HEURISTICS: readonly BotAccountHeuristic[] = [placeholderHeuristic];

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

/** The compact `id=0.00` rendering the finding's reason carries, so a moderator sees each
 *  heuristic's own number rather than only the blend. */
export function renderSubScores(subScores: HeuristicScore[]): string {
  if (!subScores.length) return 'no heuristics registered';
  return subScores.map((s) => `${s.id}=${s.score.toFixed(2)}`).join(', ');
}
