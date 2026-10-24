import {
  classAtThreshold,
  cohensKappa,
  expectedCalibrationError,
  fitClassThreshold,
  type ClassAtThreshold,
  type Scored,
  type ThresholdFit,
} from './metrics';
import type { ManifestItem, Prediction } from './types';

export type ScoreInput = {
  predictions: readonly Prediction[];
  items: readonly ManifestItem[];
  gold: ReadonlyMap<string, string>;
  classes: readonly string[];
};

export type SliceScore = {
  total: number;
  /** The image was gone before the model ran. Not a model outcome. */
  missing: number;
  /** Refused by the PII check, never sent. */
  refused: number;
  /** The model call failed. Not a wrong answer either. */
  errors: number;
  unlabelled: number;
  answered: number;
  abstained: number;
  abstentionRate: number | null;
  correct: number;
  accuracy: number | null;
  kappa: number | null;
  ece: number | null;
};

export type SplitScore = SliceScore & {
  /**
   * Share of labelled, answered-or-abstained items the model would act on. Only
   * classes with a threshold act; a class with none always routes to a human.
   */
  coverage: number | null;
  /** Abstention per gold label: does the model abstain where humans could not tell? */
  abstentionByGold: Record<string, { n: number; abstained: number; rate: number | null }>;
  perClass: Record<string, ClassAtThreshold>;
  slices: Record<string, Record<string, SliceScore>>;
};

type Joined = { item: ManifestItem; prediction?: Prediction; gold?: string };

function join(input: ScoreInput, itemFilter?: (item: ManifestItem) => boolean): Joined[] {
  const byId = new Map(input.predictions.map((p) => [p.itemId, p]));
  return input.items
    .filter((item) => !itemFilter || itemFilter(item))
    .map((item) => ({
      item,
      prediction: byId.get(item.itemId),
      gold: input.gold.get(item.itemId),
    }));
}

/** The one rule for whether a prediction counts; the planted-flip control uses it too. */
export function isAnswered(p: Prediction): p is Prediction & { status: 'ok'; pred: string } {
  return p.status === 'ok' && !p.abstained && p.pred !== null && p.pred !== undefined;
}

/** Answered, labelled items, in the shape the metrics take. */
function scoredOf(rows: readonly Joined[]): Scored[] {
  const out: Scored[] = [];
  for (const { prediction: p, gold } of rows) {
    if (!p || gold === undefined || !isAnswered(p)) continue;
    out.push({ pred: p.pred, gold, confidence: p.confidence ?? null });
  }
  return out;
}

function sliceScore(rows: readonly Joined[]): SliceScore {
  let missing = 0;
  let refused = 0;
  let errors = 0;
  let unlabelled = 0;
  let abstained = 0;
  let okLabelled = 0;
  for (const { prediction: p, gold } of rows) {
    if (p?.status === 'missing') missing++;
    else if (p?.status === 'refused') refused++;
    else if (p?.status === 'error') errors++;
    else if (p?.status === 'ok') {
      if (gold === undefined) unlabelled++;
      else {
        okLabelled++;
        if (!isAnswered(p)) abstained++;
      }
    }
  }
  const scored = scoredOf(rows);
  const correct = scored.filter((s) => s.pred === s.gold).length;
  return {
    total: rows.length,
    missing,
    refused,
    errors,
    unlabelled,
    answered: scored.length,
    abstained,
    abstentionRate: okLabelled === 0 ? null : abstained / okLabelled,
    correct,
    accuracy: scored.length === 0 ? null : correct / scored.length,
    kappa: cohensKappa(scored.map((s) => [s.pred, s.gold] as const)),
    ece: expectedCalibrationError(scored),
  };
}

/** Correct-answer count only; what the planted-flip control measures the scorer by. */
export function countCorrect(input: Omit<ScoreInput, 'gold'>, gold: ReadonlyMap<string, string>) {
  return sliceScore(join({ ...input, gold })).correct;
}

export function scoreSplit(
  input: ScoreInput,
  split: ManifestItem['split'],
  thresholds: Readonly<Record<string, number>> = {}
): SplitScore {
  const rows = join(input, (i) => i.split === split);
  const scored = scoredOf(rows);
  const perClass: Record<string, ClassAtThreshold> = {};
  for (const cls of input.classes)
    perClass[cls] = classAtThreshold(scored, cls, thresholds[cls] ?? 0);
  const buckets = new Map<string, Map<string, Joined[]>>();
  for (const row of rows) {
    for (const [dim, value] of Object.entries(row.item.slices ?? {})) {
      const byValue = buckets.get(dim) ?? new Map<string, Joined[]>();
      buckets.set(dim, byValue);
      const bucket = byValue.get(value) ?? [];
      byValue.set(value, bucket);
      bucket.push(row);
    }
  }
  const slices: SplitScore['slices'] = {};
  for (const [dim, byValue] of buckets) {
    slices[dim] = Object.fromEntries([...byValue].map(([value, b]) => [value, sliceScore(b)]));
  }
  const abstentionByGold: SplitScore['abstentionByGold'] = {};
  for (const { prediction: p, gold } of rows) {
    if (p?.status !== 'ok' || gold === undefined) continue;
    const entry = (abstentionByGold[gold] ??= { n: 0, abstained: 0, rate: null });
    entry.n++;
    if (!isAnswered(p)) entry.abstained++;
  }
  for (const entry of Object.values(abstentionByGold)) entry.rate = entry.abstained / entry.n;
  const base = sliceScore(rows);
  const decidable = base.answered + base.abstained;
  const covered = Object.entries(perClass)
    .filter(([cls]) => thresholds[cls] !== undefined)
    .reduce((sum, [, c]) => sum + c.covered, 0);
  return {
    ...base,
    coverage: decidable === 0 ? null : covered / decidable,
    abstentionByGold,
    perClass,
    slices,
  };
}

/** Only fitted classes carry a threshold; the rest always route to a human. */
export function fittedThresholds(
  fits: Readonly<Record<string, ThresholdFit>>
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(fits).flatMap(([cls, f]) => (f.status === 'fitted' ? [[cls, f.threshold]] : []))
  );
}

/** Per-class thresholds fitted on DEV. Never call this with test items. */
export function fitThresholds(
  input: ScoreInput,
  targets: Readonly<Record<string, number>>
): Record<string, ThresholdFit> {
  const scored = scoredOf(join(input, (i) => i.split === 'dev'));
  return Object.fromEntries(
    input.classes.map((cls) => {
      const target = targets[cls];
      if (target === undefined) throw new Error(`no precision target for class "${cls}"`);
      return [cls, fitClassThreshold(scored, cls, target)];
    })
  );
}
