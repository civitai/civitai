import { sql, type Kysely } from 'kysely';
import type { DB as ModeratorDB } from '../moderator-db/types';
import type { LabEntityType, LabField, LabLabel } from '../../text-scan-lab/types';
import { baselineState, type BaselineState } from '../../text-scan-tests/baseline';
import { LABEL_ORDER, type Expected } from '../../text-scan-tests/expected';
import {
  countCases,
  flipOf,
  orderFlippedFirst,
  passRates,
  scoreCase,
  summarise,
  type CaseCounts,
  type CaseScore,
  type Flip,
  type LabelSummary,
  type ResultStatus,
} from '../../text-scan-tests/score';
import {
  ACTIVE_RUN_STATUSES,
  TEST_SET_LIMITS,
  isActiveRun,
  type RunKind,
  type RunStatus,
  type TestCase,
  type TestSet,
} from '../../text-scan-tests/types';
import { asLive, latestBaseline, liveStateFor, setLabels, type RunsDeps } from './runs';
import { TestSetError, getRun, requireSet, runnableCases, type RunRow } from './store';

type Db = Kysely<ModeratorDB>;

const PREVIEW_CHARS = 300;

export type RunView = {
  id: number;
  setId: number;
  kind: RunKind;
  status: RunStatus;
  interrupted: boolean;
  baselineRunId: number | null;
  promptIds: Record<string, number>;
  overriddenKeys: string[];
  model: string;
  thinking: boolean;
  caseTotal: number;
  caseDone: number;
  errorCount: number;
  failure: string | null;
  totals: LabelSummary[] | null;
  runBy: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date | null;
};

const date = (value: Date | string | null) => (value === null ? null : new Date(value));

export function toRunView(r: RunRow, now = Date.now()): RunView {
  const heartbeat = r.heartbeat_at ? new Date(r.heartbeat_at).getTime() : null;
  return {
    id: Number(r.id),
    setId: Number(r.set_id),
    kind: r.kind as RunKind,
    status: r.status as RunStatus,
    interrupted:
      isActiveRun(r.status) &&
      r.status !== 'queued' &&
      (heartbeat === null || now - heartbeat > TEST_SET_LIMITS.leaseStaleMs),
    baselineRunId: r.baseline_run_id === null ? null : Number(r.baseline_run_id),
    promptIds: r.prompt_ids as Record<string, number>,
    overriddenKeys: Object.keys((r.prompt_overrides as Record<string, string> | null) ?? {}),
    model: r.model,
    thinking: r.thinking,
    caseTotal: r.case_total,
    caseDone: r.case_done,
    errorCount: r.error_count,
    failure: r.failure,
    totals: (r.totals as LabelSummary[] | null) ?? null,
    runBy: r.run_by,
    createdAt: new Date(r.created_at),
    startedAt: date(r.started_at),
    finishedAt: date(r.finished_at),
    expiresAt: date(r.expires_at),
  };
}

export type SetOverview = {
  set: TestSet;
  cases: { total: number; runnable: number; wiped: number };
  baseline: { state: BaselineState | 'unknown'; run: RunView | null };
  active: RunView[];
  recent: RunView[];
};

export async function setOverview(
  deps: Pick<RunsDeps, 'db' | 'getPrompts'>,
  setId: number
): Promise<SetOverview> {
  const set = await requireSet(deps.db, setId);
  const [all, withText] = await Promise.all([
    deps.db
      .selectFrom('text_scan_test_case')
      .select(sql<string>`count(*)`.as('n'))
      .where('set_id', '=', String(setId))
      .executeTakeFirstOrThrow(),
    runnableCases(deps.db, setId)
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow(),
  ]);
  const latest = await latestBaseline(deps.db, setId);
  let state: SetOverview['baseline']['state'] = 'none';
  if (latest) {
    state = 'unknown';
    try {
      const { live } = await liveStateFor(deps, await setLabels(deps.db, setId));
      state = baselineState({ ...asLive(latest), status: latest.status }, live);
    } catch (e) {
      if (!(e instanceof TestSetError)) throw e;
    }
  }
  const [active, recent] = await Promise.all([
    listRuns(deps.db, setId, { active: true }),
    listRuns(deps.db, setId, { active: false, limit: TEST_SET_LIMITS.recentRuns }),
  ]);
  const total = Number(all.n);
  const runnable = Number(withText.n);
  return {
    set,
    cases: { total, runnable, wiped: total - runnable },
    baseline: { state, run: latest ? toRunView(latest) : null },
    active,
    recent,
  };
}

/** `active`: only runs in progress (true) or only finished ones (false); omitted, both. */
export async function listRuns(
  db: Db,
  setId: number,
  opts: { active?: boolean; limit?: number } = {}
): Promise<RunView[]> {
  let query = db
    .selectFrom('text_scan_test_run')
    .selectAll()
    .where('set_id', '=', String(setId))
    .orderBy('id', 'desc')
    .limit(opts.limit ?? 100);
  if (opts.active !== undefined)
    query = query.where('status', opts.active ? 'in' : 'not in', [...ACTIVE_RUN_STATUSES]);
  const rows = await query.execute();
  const now = Date.now();
  return rows.map((r) => toRunView(r, now));
}

export type HistoryPoint = {
  runId: number;
  finishedAt: Date;
  promptIds: Record<string, number>;
  passRates: Partial<Record<LabLabel, number | null>>;
};

export async function baselineHistory(db: Db, setId: number): Promise<HistoryPoint[]> {
  const rows = await db
    .selectFrom('text_scan_test_run')
    .select(['id', 'finished_at', 'prompt_ids', 'totals'])
    .where('set_id', '=', String(setId))
    .where('kind', '=', 'baseline')
    .where('status', '=', 'done')
    .where('finished_at', 'is not', null)
    .orderBy('finished_at', 'desc')
    .limit(100)
    .execute();
  return rows.reverse().map((r) => ({
    runId: Number(r.id),
    finishedAt: new Date(r.finished_at!),
    promptIds: r.prompt_ids as Record<string, number>,
    passRates: passRates((r.totals as LabelSummary[] | null) ?? []),
  }));
}

export type ResultView = {
  status: ResultStatus;
  output: unknown;
  workflowId: string | null;
  error: string | null;
  segments: number | null;
};
export type ReportSide = { score: CaseScore; result: ResultView | null };
export type ReportCase = {
  caseId: number;
  entityType: LabEntityType;
  entityId: number | null;
  sourceRef: string | null;
  note: string | null;
  wiped: boolean;
  preview: string | null;
  expected: Expected;
  baseline: ReportSide | null;
  draft: ReportSide | null;
  flip: Flip;
};
export type RunReport = {
  set: TestSet;
  run: RunView;
  baselineRun: RunView | null;
  summary: { label: LabLabel; baseline: LabelSummary | null; draft: LabelSummary | null }[];
  counts: { baseline: CaseCounts | null; draft: CaseCounts | null };
  cases: ReportCase[];
};

async function resultsByCase(db: Db, runId: number): Promise<Map<number, ResultView>> {
  const rows = await db
    .selectFrom('text_scan_test_result')
    .selectAll()
    .where('run_id', '=', String(runId))
    .execute();
  return new Map(
    rows.map((r) => [
      Number(r.case_id),
      {
        status: r.status as ResultStatus,
        output: r.output,
        workflowId: r.workflow_id,
        error: r.error,
        segments: r.segments,
      },
    ])
  );
}

const previewOf = (fields: LabField[] | null) =>
  fields
    ? fields
        .map((f) => f.text)
        .join(' · ')
        .slice(0, PREVIEW_CHARS)
    : null;

/** Only a missing baseline reads as none; any other failure fails the report. */
const gone = (e: unknown): null => {
  if (e instanceof TestSetError && e.status === 404) return null;
  throw e;
};

export async function runReport(db: Db, setId: number, runId: number): Promise<RunReport> {
  const set = await requireSet(db, setId);
  const row = await getRun(db, setId, runId);
  const run = toRunView(row);
  const baselineRow =
    run.kind === 'draft' && run.baselineRunId !== null
      ? await getRun(db, setId, run.baselineRunId).catch(gone)
      : null;
  const baselineId = run.kind === 'baseline' ? run.id : baselineRow ? Number(baselineRow.id) : null;
  const [baseResults, draftResults] = await Promise.all([
    baselineId === null ? null : resultsByCase(db, baselineId),
    run.kind === 'draft' ? resultsByCase(db, run.id) : null,
  ]);
  const caseRows = await db
    .selectFrom('text_scan_test_case')
    .select([
      'id',
      'entity_type',
      'entity_id',
      'source_ref',
      'note',
      'fields',
      'expected',
      'source_deleted_at',
    ])
    .where('set_id', '=', String(setId))
    .where('id', '<=', row.max_case_id)
    .orderBy('id')
    .execute();

  const side = (results: Map<number, ResultView> | null, caseId: number, expected: Expected) => {
    if (!results) return null;
    const result = results.get(caseId) ?? null;
    return { result, score: scoreCase(expected, result ?? undefined) };
  };
  const cases: ReportCase[] = caseRows.map((c) => {
    const caseId = Number(c.id);
    const expected = (c.expected ?? {}) as Expected;
    const baseline = side(baseResults, caseId, expected);
    const draft = side(draftResults, caseId, expected);
    return {
      caseId,
      entityType: c.entity_type as LabEntityType,
      entityId: c.entity_id,
      sourceRef: c.source_ref,
      note: c.note,
      wiped: c.source_deleted_at !== null,
      preview: previewOf(c.fields as LabField[] | null),
      expected,
      baseline,
      draft,
      flip: draft ? flipOf(baseline?.score ?? null, draft.score) : flipOf(null, baseline!.score),
    };
  });

  const baseSummary = baseResults ? summarise(cases.map((c) => c.baseline!.score)) : null;
  const draftSummary = draftResults ? summarise(cases.map((c) => c.draft!.score)) : null;
  const find = (summaries: LabelSummary[] | null, label: LabLabel) =>
    summaries?.find((s) => s.label === label) ?? null;
  return {
    set,
    run,
    baselineRun: baselineRow && run.kind === 'draft' ? toRunView(baselineRow) : null,
    summary: LABEL_ORDER.filter(
      (label) => find(baseSummary, label) || find(draftSummary, label)
    ).map((label) => ({
      label,
      baseline: find(baseSummary, label),
      draft: find(draftSummary, label),
    })),
    counts: {
      baseline: baseResults ? countCases(cases.map((c) => c.baseline!.score)) : null,
      draft: draftResults ? countCases(cases.map((c) => c.draft!.score)) : null,
    },
    cases: orderFlippedFirst(cases),
  };
}

export type CaseListRow = Omit<TestCase, 'fields'> & { preview: string | null };

export const caseListRow = ({ fields, ...rest }: TestCase): CaseListRow => ({
  ...rest,
  preview: previewOf(fields),
});
