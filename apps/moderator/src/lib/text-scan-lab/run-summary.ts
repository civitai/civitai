import { LABEL_NAMES, describeExpected, describeVerdict, type VerdictSource } from './labels';
import { caseCorrect, diffRuns, totals } from './score';
import type { Expected, LabLabel } from './types';

/** One case's result in a test-set run, with the case's current expectation. */
export type RunRow = { caseId: number; expected: Expected; status: string; output: unknown };

export type SideScore = { correct: number; scored: number };
export type LabelSummary = {
  label: LabLabel;
  name: string;
  current: SideScore | null;
  changed: SideScore | null;
};
export type CaseChange = {
  caseId: number;
  label: LabLabel;
  expected: string;
  current: string;
  changed: string;
};
export type RunSummary = {
  labels: LabelSummary[];
  fixed: CaseChange[];
  broke: CaseChange[];
  errors: { current: number; changed: number | null };
};

const LABEL_ORDER = Object.keys(LABEL_NAMES) as LabLabel[];

export const asExpectedText = ({ correct, scored }: SideScore) =>
  `${correct} of ${scored} as expected`;

const usable = (r: RunRow): r is RunRow & { output: Record<string, unknown> } =>
  r.status === 'ok' && !!r.output && typeof r.output === 'object';

function toSource(row: RunRow | undefined): VerdictSource {
  if (row && usable(row)) return { ok: true, output: row.output };
  const error = (row?.output as { error?: unknown } | null | undefined)?.error;
  return {
    ok: false,
    error: typeof error === 'string' ? error : row?.status === 'skipped' ? 'not run' : 'no answer',
  };
}

function score(rows: RunRow[]) {
  const ok = rows.filter(usable);
  return {
    totals: totals(ok),
    correct: new Map(ok.map((r) => [r.caseId, caseCorrect(r.expected, r.output)])),
    byCase: new Map(rows.map((r) => [r.caseId, r])),
    errors: rows.filter((r) => r.status === 'error').length,
  };
}

/** Per label, how many cases came out as expected under the current prompts and, when given, with the
 *  moderator's changes; and which cases the changes fixed or broke. Only cases scored on both sides
 *  can be fixed or broken. */
export function summariseRuns(current: RunRow[], changed?: RunRow[] | null): RunSummary {
  const a = score(current);
  const b = changed ? score(changed) : null;
  const side = (s: typeof a | null, label: LabLabel): SideScore | null => {
    const t = s?.totals[label];
    return t ? { correct: t.correct, scored: t.scored } : null;
  };
  const labels = LABEL_ORDER.filter((label) => a.totals[label] || b?.totals[label]).map(
    (label) => ({
      label,
      name: LABEL_NAMES[label],
      current: side(a, label),
      changed: side(b, label),
    })
  );

  const { newlyRight, newlyWrong } = b
    ? diffRuns(a.correct, b.correct)
    : { newlyRight: [], newlyWrong: [] };
  const describe = ({ caseId, label }: { caseId: number; label: string }): CaseChange => {
    const l = label as LabLabel;
    const before = a.byCase.get(caseId)!;
    return {
      caseId,
      label: l,
      expected: describeExpected(before.expected)[l] ?? '',
      current: describeVerdict(l, toSource(before)).headline,
      changed: describeVerdict(l, toSource(b!.byCase.get(caseId))).headline,
    };
  };

  return {
    labels,
    fixed: newlyRight.map(describe),
    broke: newlyWrong.map(describe),
    errors: { current: a.errors, changed: b ? b.errors : null },
  };
}
