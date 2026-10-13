import { NSFW_LEVEL_NAMES, type LabLabel, type NsfwLevelName } from '../text-scan-lab/types';
import {
  FLAG_LABELS,
  LABEL_ORDER,
  levelRank,
  type Expected,
  type FlagLabel,
  type NsfwRange,
} from './expected';

export type ResultStatus = 'ok' | 'error' | 'skipped';
export type StoredResult = {
  status: ResultStatus;
  output: unknown;
  literalRuleIds: readonly number[] | null;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const byNumber = (a: number, b: number) => a - b;
const sorted = (ids: Iterable<number>) => [...new Set(ids)].sort(byNumber);

/** A long-input result arrives segmented (`{ merged, segments }`); scoring reads the merged verdict. */
export function verdictOf(output: unknown): {
  verdict: Record<string, unknown> | null;
  segments: number | null;
} {
  if (!isRecord(output)) return { verdict: null, segments: null };
  if (isRecord(output.merged) && Array.isArray(output.segments))
    return { verdict: output.merged, segments: output.segments.length };
  return { verdict: output, segments: null };
}

export type NsfwOutcome = {
  label: 'nsfw';
  pass: boolean;
  predicted: NsfwLevelName | null;
  /** 0 inside the range; negative below it, positive above it; null without a rating. */
  offBy: number | null;
};
export type FlagOutcome = { label: FlagLabel; pass: boolean; predicted: boolean | null };
export type RulesOutcome = {
  label: 'modelRules';
  pass: boolean;
  answered: boolean;
  caught: number[];
  missed: number[];
  falseFlags: number[];
  newRuleHits: number[];
  llm: number[];
  literal: number[];
};
export type LabelOutcome = NsfwOutcome | FlagOutcome | RulesOutcome;

export type CaseScore =
  | { state: 'scored'; pass: boolean; labels: LabelOutcome[] }
  | { state: 'error' | 'skipped' | 'missing' | 'unscored' };

function nsfwOutcome(range: NsfwRange, verdict: Record<string, unknown> | null): NsfwOutcome {
  const level = (verdict?.nsfw as { level?: unknown } | undefined)?.level;
  if (typeof level !== 'string' || !(NSFW_LEVEL_NAMES as readonly string[]).includes(level))
    return { label: 'nsfw', pass: false, predicted: null, offBy: null };
  const rank = levelRank(level as NsfwLevelName);
  const min = levelRank(range.min);
  const max = levelRank(range.max);
  const offBy = rank < min ? rank - min : rank > max ? rank - max : 0;
  return { label: 'nsfw', pass: offBy === 0, predicted: level as NsfwLevelName, offBy };
}

function flagOutcome(
  label: FlagLabel,
  expected: boolean,
  verdict: Record<string, unknown> | null
): FlagOutcome {
  const detected = (verdict?.[label] as { detected?: unknown } | undefined)?.detected;
  if (typeof detected !== 'boolean') return { label, pass: false, predicted: null };
  return { label, pass: detected === expected, predicted: detected };
}

function llmRuleIds(verdict: Record<string, unknown> | null): number[] | null {
  const block = verdict?.modelRules;
  if (!isRecord(block) || !Array.isArray(block.matched)) return null;
  return block.matched.flatMap((m) =>
    isRecord(m) && typeof m.ruleId === 'number' ? [m.ruleId] : []
  );
}

function rulesOutcome(
  expectedIds: readonly number[],
  verdict: Record<string, unknown> | null,
  literalIds: readonly number[] | null
): RulesOutcome {
  const llm = llmRuleIds(verdict);
  const literal = sorted(literalIds ?? []);
  const answered = llm !== null || literal.length > 0;
  const predicted = new Set([...(llm ?? []), ...literal]);
  const expected = new Set(expectedIds);
  const saved = [...predicted].filter((id) => id > 0);
  const caught = sorted(saved.filter((id) => expected.has(id)));
  const falseFlags = sorted(saved.filter((id) => !expected.has(id)));
  const missed = sorted([...expected].filter((id) => !predicted.has(id)));
  return {
    label: 'modelRules',
    pass: answered && !missed.length && !falseFlags.length,
    answered,
    caught,
    missed,
    falseFlags,
    newRuleHits: sorted([...predicted].filter((id) => id < 0)),
    llm: sorted(llm ?? []),
    literal,
  };
}

export function scoreCase(expected: Expected, result: StoredResult | undefined): CaseScore {
  if (!result) return { state: 'missing' };
  if (result.status !== 'ok') return { state: result.status };
  const { verdict } = verdictOf(result.output);
  const labels: LabelOutcome[] = [];
  if (expected.nsfw) labels.push(nsfwOutcome(expected.nsfw, verdict));
  for (const label of FLAG_LABELS) {
    const value = expected[label];
    if (value !== undefined) labels.push(flagOutcome(label, value, verdict));
  }
  if (expected.modelRules)
    labels.push(rulesOutcome(expected.modelRules.ruleIds, verdict, result.literalRuleIds));
  if (!labels.length) return { state: 'unscored' };
  return { state: 'scored', pass: labels.every((l) => l.pass), labels };
}

export type NsfwSummary = {
  label: 'nsfw';
  scored: number;
  passed: number;
  under: number;
  over: number;
  offByOne: number;
  unanswered: number;
};
export type FlagSummary = {
  label: FlagLabel;
  scored: number;
  passed: number;
  caught: number;
  missed: number;
  falseFlags: number;
  unanswered: number;
};
export type RuleTally = { caught: number; missed: number; falseFlags: number };
export type RulesSummary = {
  label: 'modelRules';
  scored: number;
  passed: number;
  caught: number;
  missed: number;
  falseFlags: number;
  newRuleHits: number;
  unanswered: number;
  perRule: Record<number, RuleTally>;
};
export type LabelSummary = NsfwSummary | FlagSummary | RulesSummary;

function emptySummary(label: LabLabel): LabelSummary {
  if (label === 'nsfw')
    return { label, scored: 0, passed: 0, under: 0, over: 0, offByOne: 0, unanswered: 0 };
  if (label === 'modelRules')
    return {
      label,
      scored: 0,
      passed: 0,
      caught: 0,
      missed: 0,
      falseFlags: 0,
      newRuleHits: 0,
      unanswered: 0,
      perRule: {},
    };
  return { label, scored: 0, passed: 0, caught: 0, missed: 0, falseFlags: 0, unanswered: 0 };
}

function add(summary: LabelSummary, outcome: LabelOutcome) {
  summary.scored++;
  if (outcome.pass) summary.passed++;
  if (outcome.label === 'nsfw' && summary.label === 'nsfw') {
    if (outcome.offBy === null) summary.unanswered++;
    else if (outcome.offBy < 0) summary.under++;
    else if (outcome.offBy > 0) summary.over++;
    if (outcome.offBy === 1 || outcome.offBy === -1) summary.offByOne++;
    return;
  }
  if (outcome.label === 'modelRules' && summary.label === 'modelRules') {
    if (!outcome.answered) summary.unanswered++;
    summary.caught += outcome.caught.length;
    summary.missed += outcome.missed.length;
    summary.falseFlags += outcome.falseFlags.length;
    summary.newRuleHits += outcome.newRuleHits.length;
    const tally = (id: number) => (summary.perRule[id] ??= { caught: 0, missed: 0, falseFlags: 0 });
    for (const id of outcome.caught) tally(id).caught++;
    for (const id of outcome.missed) tally(id).missed++;
    for (const id of outcome.falseFlags) tally(id).falseFlags++;
    return;
  }
  if (outcome.label !== 'nsfw' && outcome.label !== 'modelRules' && 'caught' in summary) {
    if (outcome.predicted === null) {
      summary.unanswered++;
      return;
    }
    const expectedYes = outcome.pass ? outcome.predicted : !outcome.predicted;
    if (expectedYes && outcome.predicted) summary.caught++;
    else if (expectedYes) summary.missed++;
    else if (outcome.predicted) summary.falseFlags++;
  }
}

export function summarise(scores: readonly CaseScore[]): LabelSummary[] {
  const byLabel = new Map<LabLabel, LabelSummary>();
  for (const score of scores) {
    if (score.state !== 'scored') continue;
    for (const outcome of score.labels) {
      const summary = byLabel.get(outcome.label) ?? emptySummary(outcome.label);
      byLabel.set(outcome.label, summary);
      add(summary, outcome);
    }
  }
  return LABEL_ORDER.flatMap((label) => {
    const summary = byLabel.get(label);
    return summary ? [summary] : [];
  });
}

export type CaseCounts = {
  scored: number;
  passed: number;
  error: number;
  skipped: number;
  missing: number;
  unscored: number;
};

export function countCases(scores: readonly CaseScore[]): CaseCounts {
  const counts: CaseCounts = {
    scored: 0,
    passed: 0,
    error: 0,
    skipped: 0,
    missing: 0,
    unscored: 0,
  };
  for (const score of scores) {
    counts[score.state]++;
    if (score.state === 'scored' && score.pass) counts.passed++;
  }
  return counts;
}

export type Flip = 'regressed' | 'fixed' | 'still-failing' | 'not-compared' | 'still-passing';

export function flipOf(before: CaseScore | null, after: CaseScore): Flip {
  if (after.state !== 'scored') return 'not-compared';
  if (!before) return after.pass ? 'still-passing' : 'still-failing';
  if (before.state !== 'scored') return 'not-compared';
  if (before.pass && !after.pass) return 'regressed';
  if (!before.pass && after.pass) return 'fixed';
  return after.pass ? 'still-passing' : 'still-failing';
}

const FLIP_ORDER: Record<Flip, number> = {
  regressed: 0,
  fixed: 1,
  'still-failing': 2,
  'not-compared': 3,
  'still-passing': 4,
};

export const orderFlippedFirst = <T extends { caseId: number; flip: Flip }>(rows: readonly T[]) =>
  [...rows].sort((a, b) => FLIP_ORDER[a.flip] - FLIP_ORDER[b.flip] || a.caseId - b.caseId);

export function passRates(
  summaries: readonly LabelSummary[]
): Partial<Record<LabLabel, number | null>> {
  return Object.fromEntries(summaries.map((s) => [s.label, s.scored ? s.passed / s.scored : null]));
}
