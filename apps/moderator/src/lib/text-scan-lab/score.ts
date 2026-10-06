import { NSFW_LEVEL_NAMES, type Expected, type NsfwLevelName } from './types';

const ORDER: readonly NsfwLevelName[] = NSFW_LEVEL_NAMES;
const FLAG_LABELS = ['poi', 'minor', 'scam'] as const;
/** nsfw's precision and recall treat "R or higher" as the positive class. */
const NSFW_POSITIVE = ORDER.indexOf('r');

export function caseCorrect(
  expected: Expected,
  output: Record<string, any>
): Record<string, boolean> {
  const correct: Record<string, boolean> = {};
  if (expected.nsfw && output.nsfw) {
    const i = ORDER.indexOf(output.nsfw.level);
    correct.nsfw = i >= ORDER.indexOf(expected.nsfw.min) && i <= ORDER.indexOf(expected.nsfw.max);
  }
  for (const label of FLAG_LABELS)
    if (expected[label] !== undefined && output[label])
      correct[label] = output[label].detected === expected[label];
  return correct;
}

export type LabelTotals = {
  scored: number;
  correct: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
};

const ratio = (n: number, d: number) => (d ? n / d : null);

const crossesPositive = (range: NonNullable<Expected['nsfw']>) =>
  ORDER.indexOf(range.min) < NSFW_POSITIVE && ORDER.indexOf(range.max) >= NSFW_POSITIVE;

/** Only `ok` rows count; errors and skipped cases are reported separately, never as misses. An nsfw
 *  range crossing R counts in `scored`/`correct` but not in tp/fp/fn/tn. */
export function totals(
  rows: Array<{ expected: Expected; output: Record<string, any> | null; status: string }>
): Record<string, LabelTotals> {
  const out: Record<string, LabelTotals> = {};
  for (const { expected, output, status } of rows) {
    if (status !== 'ok' || !output) continue;
    for (const [label, correct] of Object.entries(caseCorrect(expected, output))) {
      const t = (out[label] ??= {
        scored: 0,
        correct: 0,
        tp: 0,
        fp: 0,
        fn: 0,
        tn: 0,
        precision: null,
        recall: null,
      });
      t.scored++;
      if (correct) t.correct++;
      if (label === 'nsfw' && crossesPositive(expected.nsfw!)) continue;
      const [actual, predicted] =
        label === 'nsfw'
          ? [
              ORDER.indexOf(expected.nsfw!.min) >= NSFW_POSITIVE,
              ORDER.indexOf(output.nsfw.level) >= NSFW_POSITIVE,
            ]
          : [
              expected[label as (typeof FLAG_LABELS)[number]] === true,
              output[label].detected === true,
            ];
      if (actual && predicted) t.tp++;
      else if (predicted) t.fp++;
      else if (actual) t.fn++;
      else t.tn++;
    }
  }
  for (const t of Object.values(out)) {
    t.precision = ratio(t.tp, t.tp + t.fp);
    t.recall = ratio(t.tp, t.tp + t.fn);
  }
  return out;
}

type Flip = { caseId: number; label: string };

export function diffRuns(
  a: Map<number, Record<string, boolean>>,
  b: Map<number, Record<string, boolean>>
): { newlyWrong: Flip[]; newlyRight: Flip[] } {
  const newlyWrong: Flip[] = [];
  const newlyRight: Flip[] = [];
  for (const [caseId, before] of a) {
    const after = b.get(caseId);
    if (!after) continue;
    for (const [label, wasCorrect] of Object.entries(before)) {
      if (!(label in after) || after[label] === wasCorrect) continue;
      (wasCorrect ? newlyWrong : newlyRight).push({ caseId, label });
    }
  }
  return { newlyWrong, newlyRight };
}

export const scoreChips = (t: Record<string, LabelTotals> | null): string[] =>
  Object.entries(t ?? {}).map(([label, v]) => `${label} ${v.correct}/${v.scored}`);

export const percent = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
