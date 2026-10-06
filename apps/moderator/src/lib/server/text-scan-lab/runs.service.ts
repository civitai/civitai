import { sql, type Selectable } from 'kysely';
import { getModeratorDb } from '../moderator-db';
import type { text_scan_test_run } from '../moderator-db/types';
import { DraftError, getDraft, validateDraftPrompts, type DraftPrompts } from './drafts.service';
import { LabHarnessError, getPrompts, quoteTexts, scanTexts } from './harness-client';
import { getSet, listCases, type TestCase } from './test-sets.service';
import { caseCorrect, diffRuns, totals, type LabelTotals } from '$lib/text-scan-lab/score';
import type { Expected, LabEntityType, LabField, LabScanResult } from '$lib/text-scan-lab/types';

/** The most cases one run scans: each is a billed workflow, and the run executes inside one request. */
export const MAX_RUN_CASES = 500;
/** Above this many scans a run is quoted and has to be confirmed first. */
export const QUOTE_ABOVE = 10;
/** Results are written after each chunk, so a run cut short keeps what it was billed for. */
const RUN_CHUNK = 50;

export class RunError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'RunError';
  }
}

export type RunVersion = 'active' | number;
export type RunTotals = Record<string, LabelTotals>;
export type RunCounts = { ok: number; error: number; skipped: number };
export type TestRun = {
  id: number;
  setId: number;
  /** 'active' or the draft id. */
  version: string;
  draftId: number | null;
  draftUpdatedAt: Date | null;
  promptIds: Record<string, number> | null;
  model: string | null;
  status: 'running' | 'done' | 'failed';
  totals: RunTotals | null;
  runBy: number;
  startedAt: Date;
  finishedAt: Date | null;
};
export type Quote = { count: number; skipped: number; cost: number | null };

// Deliberately leaves out `prompts`: the overrides are only ever read back to re-run them.
const toRun = (r: Selectable<text_scan_test_run>): TestRun => ({
  id: Number(r.id),
  setId: Number(r.set_id),
  version: r.version,
  draftId: r.draft_id === null ? null : Number(r.draft_id),
  draftUpdatedAt: r.draft_updated_at ? new Date(r.draft_updated_at) : null,
  promptIds: (r.prompt_ids as Record<string, number> | null) ?? null,
  model: r.model,
  status: r.status as TestRun['status'],
  totals: (r.totals as RunTotals | null) ?? null,
  runBy: r.run_by,
  startedAt: new Date(r.started_at),
  finishedAt: r.finished_at ? new Date(r.finished_at) : null,
});

type RunCase = { id: number; entityType: LabEntityType; fields: LabField[]; expected: Expected };
type Plan = {
  runnable: RunCase[];
  skipped: number[];
  overrides: DraftPrompts | undefined;
  draft: { id: number; updatedAt: Date } | null;
};

const hasText = (c: TestCase) => c.fields !== null && c.sourceDeletedAt === null;

function splitCases(cases: TestCase[]): Pick<Plan, 'runnable' | 'skipped'> {
  const runnable: RunCase[] = [];
  const skipped: number[] = [];
  for (const c of cases)
    if (hasText(c))
      runnable.push({
        id: c.id,
        entityType: c.entityType,
        fields: c.fields!,
        expected: c.expected,
      });
    else skipped.push(c.id);
  return { runnable, skipped };
}

/** Re-validated here as well as on save: a draft row can reach the table without the service. */
function validOverrides(prompts: Record<string, unknown>, name: string): DraftPrompts {
  let overrides: DraftPrompts;
  try {
    overrides = validateDraftPrompts(prompts);
  } catch (e) {
    if (e instanceof DraftError) throw new RunError(`Draft "${name}": ${e.message}`, e.status);
    throw e;
  }
  if (!Object.keys(overrides).length)
    throw new RunError(`Draft "${name}" overrides no prompt — it would run active.`, 400);
  return overrides;
}

async function planRun(setId: number, version: RunVersion): Promise<Plan> {
  const set = await getSet(setId);
  if (!set) throw new RunError(`Test set ${setId} not found.`, 404);
  if (set.archivedAt) throw new RunError(`Test set "${set.name}" is archived.`, 409);

  let draft: Plan['draft'] = null;
  let overrides: DraftPrompts | undefined;
  if (version !== 'active') {
    const found = await getDraft(version);
    if (!found) throw new RunError(`Draft ${version} not found.`, 404);
    overrides = validOverrides(found.prompts, found.name);
    draft = { id: found.id, updatedAt: found.updatedAt };
  }

  const { runnable, skipped } = splitCases(await listCases(setId));
  if (!runnable.length) throw new RunError('No case in this set has text to scan.', 400);
  if (runnable.length > MAX_RUN_CASES)
    throw new RunError(
      `${runnable.length} cases exceeds the limit of ${MAX_RUN_CASES} per run — split the set.`,
      400
    );
  return { runnable, skipped, overrides, draft };
}

function byEntityType(cases: RunCase[]): Map<LabEntityType, RunCase[]> {
  const groups = new Map<LabEntityType, RunCase[]>();
  for (const c of cases) groups.set(c.entityType, [...(groups.get(c.entityType) ?? []), c]);
  return groups;
}

const toTexts = (cases: RunCase[]) => cases.map((c) => ({ key: String(c.id), fields: c.fields }));

async function quoteCases(
  cases: RunCase[],
  skipped: number,
  overrides: DraftPrompts | undefined
): Promise<Quote | null> {
  if (cases.length <= QUOTE_ABOVE) return null;
  let cost: number | null = 0;
  for (const [entityType, group] of byEntityType(cases)) {
    const q = await quoteTexts(entityType, toTexts(group), overrides);
    // An unquoted group is an unknown cost, not a free one.
    cost = q.meanCostTotal === null || cost === null ? null : cost + q.meanCostTotal * group.length;
  }
  return { count: cases.length, skipped, cost };
}

/** Null when the run is small enough to start without confirming. */
export async function quoteRun(input: { setId: number; version: RunVersion }) {
  const plan = await planRun(input.setId, input.version);
  return quoteCases(plan.runnable, plan.skipped.length, plan.overrides);
}

type ResultRow = {
  case_id: number;
  status: 'ok' | 'error' | 'skipped';
  output: unknown;
  workflow_id: string | null;
};

function toResultRow(c: RunCase, r: LabScanResult | undefined): ResultRow {
  const error = (message: string, workflowId: string | null = null): ResultRow => ({
    case_id: c.id,
    status: 'error',
    output: { error: message },
    workflow_id: workflowId,
  });
  if (!r) return error('No result returned for this case.');
  if (!r.ok) return error(r.error);
  if (!r.output) return error(`Unparsed reply: ${r.parseError ?? 'no output'}`, r.workflowId);
  return {
    case_id: c.id,
    status: 'ok',
    output: r.output,
    workflow_id: r.workflowId,
  };
}

async function writeResults(runId: number, rows: ResultRow[]) {
  if (!rows.length) return;
  const db = getModeratorDb();
  // A case removed while the run was scanning would fail the foreign key and lose the whole chunk.
  const present = new Set(
    (
      await db
        .selectFrom('text_scan_test_case')
        .select('id')
        .where(
          'id',
          'in',
          rows.map((r) => String(r.case_id))
        )
        .execute()
    ).map((r) => Number(r.id))
  );
  const values = rows
    .filter((r) => present.has(r.case_id))
    .map((r) => ({
      run_id: String(runId),
      case_id: String(r.case_id),
      status: r.status,
      output: r.output === null ? null : JSON.stringify(r.output),
      workflow_id: r.workflow_id,
    }));
  if (!values.length) return;
  await db
    .insertInto('text_scan_test_result')
    .values(values)
    .onConflict((oc) =>
      oc.columns(['run_id', 'case_id']).doUpdateSet((eb) => ({
        status: eb.ref('excluded.status'),
        output: eb.ref('excluded.output'),
        workflow_id: eb.ref('excluded.workflow_id'),
      }))
    )
    .execute();
}

const skippedRows = (caseIds: number[]): ResultRow[] =>
  caseIds.map((id) => ({
    case_id: id,
    status: 'skipped',
    output: null,
    workflow_id: null,
  }));

/** Scans in chunks, writing each chunk's results as it lands. Returns the prompt ids the harness reported. */
async function scanCases(
  runId: number,
  cases: RunCase[],
  overrides: DraftPrompts | undefined
): Promise<Record<string, number> | null> {
  let promptIds: Record<string, number> | null = null;
  for (const [entityType, group] of byEntityType(cases)) {
    // Set when this type's first request is refused before anything of it scanned: its later chunks
    // would be refused the same way. Another type's texts can still go through.
    let refusal: string | null = null;
    let scannedAny = false;
    for (let i = 0; i < group.length; i += RUN_CHUNK) {
      const chunk = group.slice(i, i + RUN_CHUNK);
      if (refusal !== null) {
        await writeResults(
          runId,
          chunk.map((c) => toResultRow(c, { key: String(c.id), ok: false, error: refusal! }))
        );
        continue;
      }
      let results: LabScanResult[];
      try {
        results = await scanTexts(entityType, toTexts(chunk), overrides);
      } catch (e) {
        const message =
          e instanceof LabHarnessError ? e.message : 'The scan request failed unexpectedly.';
        if (!(e instanceof LabHarnessError))
          console.error('text-scan run: scan request failed', (e as Error)?.message);
        if (!scannedAny && e instanceof LabHarnessError) refusal = message;
        results = chunk.map((c) => ({ key: String(c.id), ok: false as const, error: message }));
      }
      const byKey = new Map(results.map((r) => [r.key, r]));
      for (const r of results) {
        if (!r.ok) continue;
        scannedAny = true;
        promptIds = { ...r.promptIds, ...(promptIds ?? {}) };
      }
      await writeResults(
        runId,
        chunk.map((c) => toResultRow(c, byKey.get(String(c.id))))
      );
    }
  }
  return promptIds;
}

type ScoredRun = {
  correct: Map<number, Record<string, boolean>>;
  outputs: Map<number, unknown>;
  totals: RunTotals;
};

/** Scores runs' ok results against each case's CURRENT expectation, so relabelling a case moves every
 *  view of every run at once and two runs are always compared on the same labels. */
async function scoreRuns(runIds: Array<string | number>): Promise<Map<string, ScoredRun>> {
  const scored = new Map<string, ScoredRun>(
    runIds.map((id) => [String(id), { correct: new Map(), outputs: new Map(), totals: {} }])
  );
  if (!runIds.length) return scored;
  const rows = await getModeratorDb()
    .selectFrom('text_scan_test_result as r')
    .innerJoin('text_scan_test_case as c', 'c.id', 'r.case_id')
    .select(['r.run_id', 'r.case_id', 'r.output', 'c.expected'])
    .where(
      'r.run_id',
      'in',
      runIds.map((id) => String(id))
    )
    .where('r.status', '=', 'ok')
    .execute();
  const byRun = new Map<string, typeof rows>();
  for (const r of rows) byRun.set(String(r.run_id), [...(byRun.get(String(r.run_id)) ?? []), r]);
  for (const [runId, runRows] of byRun) {
    const run = scored.get(runId)!;
    const inputs = runRows.map((r) => ({
      status: 'ok',
      expected: (r.expected ?? {}) as Expected,
      output: r.output as Record<string, unknown> | null,
    }));
    run.totals = totals(inputs);
    runRows.forEach((r, i) => {
      run.outputs.set(Number(r.case_id), r.output);
      if (inputs[i].output)
        run.correct.set(Number(r.case_id), caseCorrect(inputs[i].expected, inputs[i].output!));
    });
  }
  return scored;
}

/** Closes the run: `failed` when every scanned case errored. */
async function finishRun(
  runId: number,
  promptIds: Record<string, number> | null,
  { failed = false } = {}
): Promise<TestRun> {
  const db = getModeratorDb();
  const statuses = (
    await db
      .selectFrom('text_scan_test_result')
      .select('status')
      .distinct()
      .where('run_id', '=', String(runId))
      .execute()
  ).map((r) => r.status);
  const allErrored = !statuses.includes('ok') && statuses.includes('error');
  const scored = (await scoreRuns([runId])).get(String(runId))!;
  const run = await db
    .updateTable('text_scan_test_run')
    .set({
      status: failed || allErrored ? 'failed' : 'done',
      totals: JSON.stringify(scored.totals),
      finished_at: sql`now()`,
      prompt_ids: promptIds
        ? sql`coalesce(prompt_ids, ${JSON.stringify(promptIds)}::jsonb)`
        : sql`prompt_ids`,
    })
    .where('id', '=', String(runId))
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRun(run);
}

/** Scans, then closes the run; an unexpected throw still closes it as failed with what was written. */
async function execute(runId: number, cases: RunCase[], overrides: DraftPrompts | undefined) {
  try {
    const promptIds = await scanCases(runId, cases, overrides);
    return await finishRun(runId, promptIds);
  } catch (e) {
    await finishRun(runId, null, { failed: true }).catch(() => undefined);
    throw e;
  }
}

/** Runs every case in the set that still has text; the rest are recorded as skipped. */
export async function startRun(
  input: { setId: number; version: RunVersion },
  userId: number
): Promise<TestRun> {
  const plan = await planRun(input.setId, input.version);
  const model = await getPrompts().then(
    (p) => p.config.model,
    () => null
  );
  const run = await getModeratorDb()
    .insertInto('text_scan_test_run')
    .values({
      set_id: String(input.setId),
      version: plan.draft ? String(plan.draft.id) : 'active',
      draft_id: plan.draft ? String(plan.draft.id) : null,
      draft_updated_at: plan.draft?.updatedAt ?? null,
      prompts: plan.overrides ? JSON.stringify(plan.overrides) : null,
      model,
      status: 'running',
      run_by: userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const runId = Number(run.id);
  await writeResults(runId, skippedRows(plan.skipped));
  return execute(runId, plan.runnable, plan.overrides);
}

async function getRunRow(setId: number, runId: number) {
  const row = await getModeratorDb()
    .selectFrom('text_scan_test_run')
    .selectAll()
    .where('id', '=', String(runId))
    .where('set_id', '=', String(setId))
    .executeTakeFirst();
  if (!row) throw new RunError(`Run ${runId} not found in this set.`, 404);
  return row;
}

/** The run's error cases, as they read now; a case whose source was deleted since is skipped. */
async function planRerun(setId: number, runId: number) {
  const set = await getSet(setId);
  if (set?.archivedAt) throw new RunError(`Test set "${set.name}" is archived.`, 409);
  const run = await getRunRow(setId, runId);
  if (run.status === 'running')
    throw new RunError(
      'This run has not finished. If it was interrupted, start a new run instead.',
      409
    );

  let overrides: DraftPrompts | undefined;
  if (run.version !== 'active') {
    if (!run.prompts) throw new RunError('This run did not record the prompts it ran.', 409);
    overrides = validOverrides(run.prompts as Record<string, unknown>, `#${run.version}`);
  }

  const errorIds = (
    await getModeratorDb()
      .selectFrom('text_scan_test_result')
      .select('case_id')
      .where('run_id', '=', String(runId))
      .where('status', '=', 'error')
      .execute()
  ).map((r) => Number(r.case_id));
  if (!errorIds.length) throw new RunError('This run has no errors to re-run.', 400);
  const errorSet = new Set(errorIds);
  const { runnable, skipped } = splitCases(
    (await listCases(setId)).filter((c) => errorSet.has(c.id))
  );
  return { run, overrides, runnable, skipped };
}

/** The harness reports a label's prompt id under the label name; the prompt store keys it `label:<name>`. */
const promptKeyOf = (idKey: string) => (idKey === 'base' ? idKey : `label:${idKey}`);

/** Keys that ran active (an override reports id 0) and are no longer the active version. */
async function changedActiveKeys(promptIds: Record<string, number> | null): Promise<string[]> {
  if (!promptIds) return [];
  let active: Awaited<ReturnType<typeof getPrompts>>['active'];
  try {
    active = (await getPrompts()).active;
  } catch (e) {
    if (e instanceof LabHarnessError) throw new RunError(e.message, 502);
    throw e;
  }
  return Object.entries(promptIds)
    .filter(([key, id]) => id > 0 && active[promptKeyOf(key)]?.id !== id)
    .map(([key]) => promptKeyOf(key));
}

export async function quoteRerun(setId: number, runId: number) {
  const { runnable, skipped, overrides } = await planRerun(setId, runId);
  return quoteCases(runnable, skipped.length, overrides);
}

/** Re-scans only the run's error rows, with the prompts the run recorded — never the draft's current
 *  text — and recomputes its totals. */
export async function rerunErrors(setId: number, runId: number): Promise<TestRun> {
  const { run, overrides, runnable, skipped } = await planRerun(setId, runId);
  const changed = await changedActiveKeys(run.prompt_ids as Record<string, number> | null);
  if (changed.length)
    throw new RunError(
      `Active ${changed.join(
        ', '
      )} changed since this run, so a re-run would mix versions — start a new run.`,
      409
    );

  // Claimed first so a second click cannot bill the same errors twice.
  const claimed = await getModeratorDb()
    .updateTable('text_scan_test_run')
    .set({ status: 'running' })
    .where('id', '=', String(runId))
    .where('status', '=', run.status)
    .executeTakeFirst();
  if (!claimed.numUpdatedRows) throw new RunError('This run is already being re-run.', 409);

  await writeResults(runId, skippedRows(skipped));
  return execute(runId, runnable, overrides);
}

export type RunListItem = TestRun & {
  counts: RunCounts;
  errors: { caseId: number; error: string }[];
};

/** The set's latest runs, newest first, each with its result counts and error messages. */
export async function listRuns(setId: number, limit = 20): Promise<RunListItem[]> {
  const db = getModeratorDb();
  const runs = await db
    .selectFrom('text_scan_test_run')
    .selectAll()
    .where('set_id', '=', String(setId))
    .orderBy('started_at', 'desc')
    .limit(limit)
    .execute();
  if (!runs.length) return [];
  const ids = runs.map((r) => r.id);
  const [counts, errors, scored] = await Promise.all([
    db
      .selectFrom('text_scan_test_result')
      .select(['run_id', 'status', db.fn.countAll<string>().as('n')])
      .where('run_id', 'in', ids)
      .groupBy(['run_id', 'status'])
      .execute(),
    db
      .selectFrom('text_scan_test_result')
      .select(['run_id', 'case_id', sql<string>`output->>'error'`.as('error')])
      .where('run_id', 'in', ids)
      .where('status', '=', 'error')
      .orderBy('case_id')
      .execute(),
    scoreRuns(ids),
  ]);
  return runs.map((r) => {
    const c: RunCounts = { ok: 0, error: 0, skipped: 0 };
    for (const row of counts)
      if (row.run_id === r.id) c[row.status as keyof RunCounts] = Number(row.n);
    return {
      ...toRun(r),
      totals: scored.get(String(r.id))!.totals,
      counts: c,
      errors: errors
        .filter((e) => e.run_id === r.id)
        .map((e) => ({ caseId: Number(e.case_id), error: e.error ?? 'Unknown error' })),
    };
  });
}

export type CaseFlip = {
  caseId: number;
  label: string;
  outputA: unknown;
  outputB: unknown;
};
export type RunComparison = {
  a: TestRun;
  b: TestRun;
  newlyWrong: CaseFlip[];
  newlyRight: CaseFlip[];
};

/** Labels scored in both runs whose correctness flipped from `a` to `b`, with both outputs. */
export async function compareRuns(setId: number, aId: number, bId: number): Promise<RunComparison> {
  const [a, b] = await Promise.all([getRunRow(setId, aId), getRunRow(setId, bId)]);
  const scored = await scoreRuns([a.id, b.id]);
  const sideA = scored.get(String(a.id))!;
  const sideB = scored.get(String(b.id))!;
  const { newlyWrong, newlyRight } = diffRuns(sideA.correct, sideB.correct);
  const withOutputs = (flips: { caseId: number; label: string }[]) =>
    flips.map((f) => ({
      ...f,
      outputA: sideA.outputs.get(f.caseId) ?? null,
      outputB: sideB.outputs.get(f.caseId) ?? null,
    }));
  return {
    a: { ...toRun(a), totals: sideA.totals },
    b: { ...toRun(b), totals: sideB.totals },
    newlyWrong: withOutputs(newlyWrong),
    newlyRight: withOutputs(newlyRight),
  };
}

export type LatestRun = {
  runId: number;
  startedAt: Date;
  draftUpdatedAt: Date | null;
  totals: RunTotals;
};

export type SetLatestRuns = { active: LatestRun | null; drafts: Record<string, LatestRun> };

/** Per set, each version's latest finished run: what the publish panel shows beside a draft. */
export async function latestRunTotalsForSets(
  setIds: number[]
): Promise<Map<number, SetLatestRuns>> {
  const out = new Map<number, SetLatestRuns>(
    setIds.map((id) => [id, { active: null, drafts: {} }])
  );
  if (!setIds.length) return out;
  const rows = await getModeratorDb()
    .selectFrom('text_scan_test_run')
    .distinctOn(['set_id', 'version'])
    .select(['id', 'set_id', 'version', 'started_at', 'draft_updated_at'])
    .where('set_id', 'in', setIds.map(String))
    .where('status', '=', 'done')
    .orderBy('set_id')
    .orderBy('version')
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const scored = await scoreRuns(rows.map((r) => r.id));
  for (const r of rows) {
    const latest: LatestRun = {
      runId: Number(r.id),
      startedAt: new Date(r.started_at),
      draftUpdatedAt: r.draft_updated_at ? new Date(r.draft_updated_at) : null,
      totals: scored.get(String(r.id))!.totals,
    };
    const set = out.get(Number(r.set_id))!;
    if (r.version === 'active') set.active = latest;
    else set.drafts[r.version] = latest;
  }
  return out;
}

export async function latestRunTotals(setId: number): Promise<SetLatestRuns> {
  return (await latestRunTotalsForSets([setId])).get(setId)!;
}
