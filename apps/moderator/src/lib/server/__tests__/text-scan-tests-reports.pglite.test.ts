import type { Kysely } from 'kysely';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DB as ModeratorDB } from '../moderator-db/types';
import { MOD, useTestSetsDb, seedCase, seedRun, seedSet } from './text-scan-tests-pglite.harness';

vi.mock('../user-actions.service', () => ({ callModEndpoint: vi.fn() }));

const { LabHarnessError } = await import('../text-scan-lab/harness-client');
const { updateExpectation } = await import('../text-scan-tests/store');
const { wipeCases } = await import('../text-scan-tests/sources');
const { refreshSetTotals } = await import('../text-scan-tests/totals');
const { baselineHistory, runReport, setOverview } = await import('../text-scan-tests/reports');

let db: Kysely<ModeratorDB>;
let setId: number;

function makeDeps() {
  const prompts = {
    active: {
      base: { id: 1, key: 'base', content: 'synthetic base' },
      'label:scam': { id: 2, key: 'label:scam', content: 'synthetic scam' },
    },
    config: { model: 'model-a', maxInputChars: 1000, thinking: false },
  };
  return {
    prompts,
    deps: {
      db,
      getPrompts: vi.fn(async () => prompts),
    },
  };
}

const sets = useTestSetsDb();

beforeEach(async () => {
  ({ db } = sets);
  setId = await seedSet(db);
});

const scam = (detected: boolean) => JSON.stringify({ scam: { detected, reason: 'synthetic' } });

async function result(runId: number, caseId: number, status: string, output: string | null = null) {
  await db
    .insertInto('text_scan_test_result')
    .values({
      run_id: String(runId),
      case_id: String(caseId),
      status,
      output,
      error: status === 'error' ? 'synthetic failure' : null,
    })
    .execute();
}

describe('setOverview', () => {
  it('reports no baseline, then a fresh one, then a stale one after a save', async () => {
    await seedCase(db, setId);
    const { deps, prompts } = makeDeps();
    expect((await setOverview(deps, setId)).baseline.state).toBe('none');
    await seedRun(db, setId, { status: 'done' });
    expect((await setOverview(deps, setId)).baseline.state).toBe('fresh');
    prompts.active['label:scam'] = { ...prompts.active['label:scam'], id: 3 };
    expect((await setOverview(deps, setId)).baseline.state).toBe('stale');
  });

  it('reports a queued baseline as running, and unknown when the harness is down', async () => {
    await seedCase(db, setId);
    await seedRun(db, setId);
    const { deps } = makeDeps();
    expect((await setOverview(deps, setId)).baseline.state).toBe('running');
    deps.getPrompts.mockRejectedValue(new LabHarnessError('Load text-scan prompts failed.'));
    expect((await setOverview(deps, setId)).baseline.state).toBe('unknown');
  });

  it('splits active runs from the five most recent finished ones and flags an interrupted run', async () => {
    await seedCase(db, setId);
    await seedCase(db, setId, { fields: null });
    for (let i = 0; i < 6; i++) await seedRun(db, setId, { status: 'done' });
    const stuck = await seedRun(db, setId, {
      status: 'running',
      leaseOwner: 'host:1:x',
      heartbeatAt: new Date(Date.now() - 6 * 60_000),
    });
    const { deps } = makeDeps();
    const overview = await setOverview(deps, setId);
    expect(overview.cases).toEqual({ total: 2, runnable: 1, wiped: 1 });
    expect(overview.active.map((r) => [r.id, r.interrupted])).toEqual([[stuck, true]]);
    expect(overview.recent).toHaveLength(5);
  });

  it('lists a run in progress behind more than 50 newer finished runs', async () => {
    await seedCase(db, setId);
    const active = await seedRun(db, setId, { status: 'running', heartbeatAt: new Date() });
    for (let i = 0; i < 51; i++) await seedRun(db, setId, { status: 'done' });
    const { deps } = makeDeps();
    const overview = await setOverview(deps, setId);
    expect(overview.active.map((r) => r.id)).toEqual([active]);
    expect(overview.recent).toHaveLength(5);
  });

  it('refuses an unknown set', async () => {
    const { deps } = makeDeps();
    await expect(setOverview(deps, 999)).rejects.toMatchObject({ status: 404 });
  });
});

describe('baselineHistory', () => {
  it('lists finished baselines oldest first, with pass rates from their totals', async () => {
    const totals = (passed: number) => [
      { label: 'scam', scored: 4, passed, caught: 0, missed: 0, falseFlags: 0, unanswered: 0 },
    ];
    const first = await seedRun(db, setId, {
      status: 'done',
      finishedAt: new Date('2026-10-01'),
      totals: totals(2),
    });
    const second = await seedRun(db, setId, {
      status: 'done',
      finishedAt: new Date('2026-10-05'),
      promptIds: { base: 1, scam: 3 },
      totals: totals(3),
    });
    await seedRun(db, setId, { status: 'failed', finishedAt: new Date('2026-10-06') });
    await seedRun(db, setId, {
      kind: 'draft',
      status: 'done',
      finishedAt: new Date('2026-10-07'),
      totals: totals(4),
    });
    expect(await baselineHistory(db, setId)).toEqual([
      {
        runId: first,
        finishedAt: new Date('2026-10-01'),
        promptIds: { base: 1, scam: 2 },
        passRates: { scam: 0.5 },
      },
      {
        runId: second,
        finishedAt: new Date('2026-10-05'),
        promptIds: { base: 1, scam: 3 },
        passRates: { scam: 0.75 },
      },
    ]);
  });
});

describe('runReport', () => {
  it('compares a draft with its baseline, regressions first', async () => {
    const expectScam = { scam: true };
    const [regressed, fixed, same, errored] = [
      await seedCase(db, setId, { expected: expectScam }),
      await seedCase(db, setId, { expected: expectScam }),
      await seedCase(db, setId, { expected: expectScam }),
      await seedCase(db, setId, { expected: expectScam }),
    ];
    const wiped = await seedCase(db, setId, { fields: null, expected: expectScam });
    const baseline = await seedRun(db, setId, { status: 'done' });
    const draft = await seedRun(db, setId, {
      kind: 'draft',
      status: 'done',
      baselineRunId: baseline,
    });
    for (const [caseId, before, after] of [
      [regressed, true, false],
      [fixed, false, true],
      [same, true, true],
      [errored, true, null],
    ] as const) {
      await result(baseline, caseId, 'ok', scam(before));
      await (after === null
        ? result(draft, caseId, 'error')
        : result(draft, caseId, 'ok', scam(after)));
    }
    await result(baseline, wiped, 'skipped');
    await result(draft, wiped, 'skipped');

    const report = await runReport(db, setId, draft);
    expect(report.cases.map((c) => [c.caseId, c.flip])).toEqual([
      [regressed, 'regressed'],
      [fixed, 'fixed'],
      [errored, 'not-compared'],
      [wiped, 'not-compared'],
      [same, 'still-passing'],
    ]);
    expect(report.cases.find((c) => c.caseId === wiped)).toMatchObject({
      wiped: true,
      preview: null,
    });
    expect(report.summary).toEqual([
      {
        label: 'scam',
        baseline: {
          label: 'scam',
          scored: 4,
          passed: 3,
          caught: 3,
          missed: 1,
          falseFlags: 0,
          unanswered: 0,
        },
        draft: {
          label: 'scam',
          scored: 3,
          passed: 2,
          caught: 2,
          missed: 1,
          falseFlags: 0,
          unanswered: 0,
        },
      },
    ]);
    expect(report.counts.draft).toMatchObject({ scored: 3, error: 1, skipped: 1 });
    expect(report.baselineRun?.id).toBe(baseline);
  });

  it('reports a baseline alone, failing cases first', async () => {
    const passes = await seedCase(db, setId, { expected: { scam: false } });
    const fails = await seedCase(db, setId, { expected: { scam: true } });
    const baseline = await seedRun(db, setId, { status: 'done' });
    await result(baseline, passes, 'ok', scam(false));
    await result(baseline, fails, 'ok', scam(false));
    const report = await runReport(db, setId, baseline);
    expect(report.cases.map((c) => c.caseId)).toEqual([fails, passes]);
    expect(report.cases[0].draft).toBeNull();
    expect(report.baselineRun).toBeNull();
  });

  it('fails rather than drop the baseline when reading it fails', async () => {
    await seedCase(db, setId);
    const baseline = await seedRun(db, setId, { status: 'done' });
    const draft = await seedRun(db, setId, {
      kind: 'draft',
      status: 'done',
      baselineRunId: baseline,
    });
    let runReads = 0;
    const failing = db.withPlugin({
      transformQuery: ({ node }) => {
        if (
          node.kind === 'SelectQueryNode' &&
          JSON.stringify(node.from).includes('text_scan_test_run') &&
          ++runReads === 2
        )
          throw new Error('synthetic connection lost');
        return node;
      },
      transformResult: async ({ result }) => result,
    });
    await expect(runReport(failing, setId, draft)).rejects.toThrow('synthetic connection lost');
  });

  it('refuses a run of another set', async () => {
    const other = await seedSet(db);
    const runId = await seedRun(db, other, { status: 'done' });
    await expect(runReport(db, setId, runId)).rejects.toMatchObject({ status: 404 });
  });
});

describe('wiped cases', () => {
  it('leaves a wiped verdict out of the totals and the report instead of failing it', async () => {
    const kept = await seedCase(db, setId, { expected: { scam: true } });
    const wiped = await seedCase(db, setId, { expected: { scam: true } });
    const runId = await seedRun(db, setId, { status: 'done' });
    await result(runId, kept, 'ok', scam(true));
    await result(runId, wiped, 'ok', scam(true));
    await wipeCases(db, [wiped]);
    await refreshSetTotals(db, setId);

    const [run] = await db.selectFrom('text_scan_test_run').select('totals').execute();
    expect(run.totals).toEqual([expect.objectContaining({ label: 'scam', scored: 1, passed: 1 })]);
    const report = await runReport(db, setId, runId);
    expect(report.counts.baseline).toMatchObject({ scored: 1, passed: 1, missing: 1 });
    expect(report.cases.find((c) => c.caseId === wiped)).toMatchObject({
      wiped: true,
      baseline: { score: { state: 'missing' } },
    });
  });
});

describe('refreshSetTotals', () => {
  it('rescores finished runs after a relabel and leaves expired drafts alone', async () => {
    const caseId = await seedCase(db, setId, { expected: { scam: true } });
    const runId = await seedRun(db, setId, { status: 'done' });
    const expired = await seedRun(db, setId, {
      kind: 'draft',
      status: 'done',
      expiresAt: new Date('2026-01-01'),
      totals: [{ label: 'scam', scored: 9, passed: 9 }],
    });
    await result(runId, caseId, 'ok', scam(false));
    await updateExpectation(db, setId, caseId, { scam: false }, null, MOD);

    expect(await refreshSetTotals(db, setId)).toBe(1);
    const rows = await db
      .selectFrom('text_scan_test_run')
      .select(['id', 'totals'])
      .orderBy('id')
      .execute();
    expect(rows.find((r) => Number(r.id) === runId)?.totals).toMatchObject([
      { label: 'scam', passed: 1 },
    ]);
    expect(rows.find((r) => Number(r.id) === expired)?.totals).toMatchObject([{ scored: 9 }]);
  });
});
