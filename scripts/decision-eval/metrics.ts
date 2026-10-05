/**
 * Pure scoring math. Every undefined metric is `null`, never 0 — an empty slice
 * is "nothing to measure", not "everything wrong".
 */

export const WILSON_Z_95 = 1.959963984540054;

export function wilsonInterval(
  successes: number,
  n: number,
  z = WILSON_Z_95
): { lower: number; upper: number } | null {
  if (n <= 0) return null;
  if (successes < 0 || successes > n) {
    throw new Error(`wilsonInterval: ${successes} successes out of ${n}`);
  }
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

export function wilsonLower(successes: number, n: number): number | null {
  return wilsonInterval(successes, n)?.lower ?? null;
}

/** Unweighted Cohen's kappa over paired labels. */
export function cohensKappa(pairs: ReadonlyArray<readonly [string, string]>): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const left = new Map<string, number>();
  const right = new Map<string, number>();
  let agree = 0;
  for (const [a, b] of pairs) {
    if (a === b) agree++;
    left.set(a, (left.get(a) ?? 0) + 1);
    right.set(b, (right.get(b) ?? 0) + 1);
  }
  const observed = agree / n;
  let expected = 0;
  for (const [label, count] of left) expected += (count / n) * ((right.get(label) ?? 0) / n);
  if (expected === 1) return observed === 1 ? 1 : null;
  return (observed - expected) / (1 - expected);
}

export type Scored = { pred: string; gold: string; confidence: number | null };

/** Expected calibration error over items that carry a confidence. */
export function expectedCalibrationError(items: readonly Scored[], bins = 10): number | null {
  const withConf = items.filter((i): i is Scored & { confidence: number } => i.confidence !== null);
  if (withConf.length === 0) return null;
  const totals = Array.from({ length: bins }, () => ({ n: 0, conf: 0, correct: 0 }));
  for (const item of withConf) {
    const bin = Math.min(bins - 1, Math.floor(item.confidence * bins));
    totals[bin].n++;
    totals[bin].conf += item.confidence;
    totals[bin].correct += item.pred === item.gold ? 1 : 0;
  }
  let ece = 0;
  for (const t of totals) {
    if (t.n === 0) continue;
    ece += (t.n / withConf.length) * Math.abs(t.conf / t.n - t.correct / t.n);
  }
  return ece;
}

export type ClassAtThreshold = {
  threshold: number;
  covered: number;
  correct: number;
  precision: number | null;
  wilsonLower: number | null;
};

/** Items predicted as `cls` with confidence >= threshold. A null confidence never clears a threshold above 0. */
/** A threshold of 0 covers everything, a missing confidence included. */
export function clearsThreshold(confidence: number | null, threshold: number): boolean {
  return !(threshold > 0 && (confidence === null || confidence < threshold));
}

export function classAtThreshold(
  items: readonly Scored[],
  cls: string,
  threshold: number
): ClassAtThreshold {
  let covered = 0;
  let correct = 0;
  for (const item of items) {
    if (item.pred !== cls) continue;
    if (!clearsThreshold(item.confidence, threshold)) continue;
    covered++;
    if (item.gold === cls) correct++;
  }
  return {
    threshold,
    covered,
    correct,
    precision: covered === 0 ? null : correct / covered,
    wilsonLower: wilsonLower(correct, covered),
  };
}

export type ThresholdFit =
  | { status: 'fitted'; threshold: number; atThreshold: ClassAtThreshold }
  /** Even a perfect record over every item predicted as this class could not clear the target. */
  | { status: 'insufficient-n'; available: number; bestPossibleLower: number | null }
  | { status: 'no-threshold'; available: number };

/**
 * The lowest confidence threshold whose Wilson lower bound on precision clears
 * `target`, for one predicted class. Fit on DEV only; apply unchanged to test.
 */
export function fitClassThreshold(
  items: readonly Scored[],
  cls: string,
  target: number
): ThresholdFit {
  const all = classAtThreshold(items, cls, 0);
  const bestPossibleLower = wilsonLower(all.covered, all.covered);
  if (bestPossibleLower === null || bestPossibleLower < target) {
    return { status: 'insufficient-n', available: all.covered, bestPossibleLower };
  }
  if (all.wilsonLower !== null && all.wilsonLower >= target) {
    return { status: 'fitted', threshold: 0, atThreshold: all };
  }
  // One sorted sweep instead of re-scanning every item per candidate threshold.
  const ranked = items
    .filter((i): i is Scored & { confidence: number } => i.pred === cls && i.confidence !== null)
    .sort((a, b) => a.confidence - b.confidence);
  const correctFrom = new Array<number>(ranked.length + 1).fill(0);
  for (let i = ranked.length - 1; i >= 0; i--) {
    correctFrom[i] = correctFrom[i + 1] + (ranked[i].gold === cls ? 1 : 0);
  }
  for (let i = 0; i < ranked.length; i++) {
    if (i > 0 && ranked[i].confidence === ranked[i - 1].confidence) continue;
    const t = ranked[i].confidence;
    if (t <= 0) continue;
    const covered = ranked.length - i;
    const correct = correctFrom[i];
    const lower = wilsonLower(correct, covered);
    if (lower !== null && lower >= target) {
      return {
        status: 'fitted',
        threshold: t,
        atThreshold: {
          threshold: t,
          covered,
          correct,
          precision: correct / covered,
          wilsonLower: lower,
        },
      };
    }
  }
  return { status: 'no-threshold', available: all.covered };
}
