import { describe, expect, it, vi } from 'vitest';

// `training-orchestration.service` pulls the Postgres and ClickHouse clients at import; neither is
// touched by the pure functions under test, and `db` deliberately throws on import without
// DATABASE_REPLICA_URL.
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));

const { mergeOrchestratorRuns, submitSecond } = await import('../training-orchestration.service');
type Merge = typeof mergeOrchestratorRuns;
type ChargeRef = Parameters<Merge>[0][number];
type StepRow = Parameters<Merge>[1][number];
type JobRow = Parameters<Merge>[2][number];
type RefundRow = Parameters<Merge>[3][number];

const refund = (amount: number, workflowId = '11579707-20260529164941242'): RefundRow => ({
  workflowId,
  amount,
});

const charge = (over: Partial<ChargeRef> = {}): ChargeRef => ({
  id: 'tx',
  date: '2026-05-29 16:49:41',
  workflowId: '11579707-20260529164941242',
  ...over,
});

const job = (over: Partial<JobRow> = {}): JobRow => ({
  second: '2026-05-29 16:49:41.000',
  jobType: 'AIToolkitTrainingEpoch',
  jobs: 10,
  cost: 666,
  provider: 'ValdiAI',
  lastCompletedAt: '2026-05-29 17:57:45.390',
  resources: [889818],
  ...over,
});

const step = (over: Partial<StepRow> = {}): StepRow => ({
  workflowId: '11579707-20260529164941242',
  type: 'model/ai-toolkit/sdxl',
  status: 'succeeded',
  jobs: 42,
  cost: 479,
  failureClass: '',
  ...over,
});

const base = {
  modelVersionId: 889818,
  modelId: 795765,
  modelName: 'Illustrious-XL',
  versionName: 'v0.1',
  baseModel: 'Illustrious',
};
const baseModels = new Map([[889818, base]]);

describe('submitSecond', () => {
  it('reads the run instant out of the workflow id', () => {
    // Real pair: the workflow id carries milliseconds the charge's own second-precision date drops.
    expect(submitSecond(charge())).toBe('2026-05-29 16:49:41');
  });

  it('falls back to the charge date on a pre-2024-10 charge with no workflow id', () => {
    expect(submitSecond(charge({ workflowId: null }))).toBe('2026-05-29 16:49:41');
  });

  it('returns null rather than a wrong instant when neither is usable', () => {
    expect(
      submitSecond(charge({ workflowId: 'no-timestamp-here', date: 'not a date' }))
    ).toBeNull();
  });
});

describe('mergeOrchestratorRuns', () => {
  it('joins jobs to the charge on the submit second', () => {
    const runs = mergeOrchestratorRuns([charge()], [], [job()], [], baseModels);
    expect(runs.tx).toMatchObject({
      epochs: 10,
      cost: 666,
      provider: 'ValdiAI',
      baseModels: [base],
      status: null,
      ambiguous: false,
    });
  });

  it('still matches when the jobs land in the second AFTER the charge', () => {
    // The jobs of a workflow are written ~150ms after the charge, so a charge late in a second rolls
    // over. Without the offset this reads as "nothing survives" on a run that is right there.
    const runs = mergeOrchestratorRuns(
      [charge()],
      [],
      [job({ second: '2026-05-29 16:49:42.000' })],
      [],
      baseModels
    );
    expect(runs.tx?.epochs).toBe(10);
  });

  it('does not reach further than one second', () => {
    expect(
      mergeOrchestratorRuns(
        [charge()],
        [],
        [job({ second: '2026-05-29 16:49:43.000' })],
        [],
        baseModels
      )
    ).toEqual({});
  });

  it('reports a run that was submitted but never dispatched a training job', () => {
    // The signal this whole panel exists for: charged, gated, no epoch ever ran.
    const runs = mergeOrchestratorRuns(
      [charge()],
      [],
      [
        job({ jobType: 'Gate', jobs: 1, cost: 0, provider: '', resources: [] }),
        job({ jobType: 'AgeClassification', jobs: 1, cost: 1, resources: [] }),
      ],
      [],
      baseModels
    );
    expect(runs.tx).toMatchObject({ epochs: null, baseModels: [] });
    expect(runs.tx?.jobTypes).toEqual([
      { type: 'AgeClassification', count: 1 },
      { type: 'Gate', count: 1 },
    ]);
  });

  it('takes the status and the ecosystem from the step row', () => {
    const runs = mergeOrchestratorRuns(
      [charge()],
      [step({ status: 'canceled' })],
      [job()],
      [],
      baseModels
    );
    expect(runs.tx).toMatchObject({ status: 'canceled', engine: 'ai-toolkit/sdxl' });
  });

  it('reports a step-only run, from before the jobs window', () => {
    const runs = mergeOrchestratorRuns([charge()], [step()], [], [], baseModels);
    expect(runs.tx).toMatchObject({ status: 'succeeded', epochs: null, cost: null });
  });

  it('omits a charge neither table knows, rather than inventing an empty run', () => {
    expect(mergeOrchestratorRuns([charge()], [], [], [], baseModels)).toEqual({});
  });

  it('flags two charges that resolve to the same second instead of reporting the jobs twice over', () => {
    // Two workflows submitted inside one second. `jobs` has no workflow column, so the bucket cannot be
    // split — reporting 10 epochs against each without saying so would double the account's real usage.
    const runs = mergeOrchestratorRuns(
      [
        charge({ id: 'a', workflowId: '11579707-20260529164941242' }),
        charge({ id: 'b', workflowId: '11579707-20260529164941801' }),
      ],
      [],
      [job()],
      [],
      baseModels
    );
    expect(runs.a?.ambiguous).toBe(true);
    expect(runs.b?.ambiguous).toBe(true);
  });

  it('does not flag two charges a second apart that each found their own jobs', () => {
    const runs = mergeOrchestratorRuns(
      [
        charge({ id: 'a', workflowId: '11579707-20260529164941242' }),
        charge({ id: 'b', workflowId: '11579707-20260529164942242' }),
      ],
      [],
      [job(), job({ second: '2026-05-29 16:49:42.000' })],
      [],
      baseModels
    );
    expect(runs.a?.ambiguous).toBe(false);
    expect(runs.b?.ambiguous).toBe(false);
  });

  it('does not attribute a bucket to a charge whose second it does not match', () => {
    // The cap means some charges go unlooked-up. Their rows must stay ABSENT so the panel can say "not
    // looked up" — filling them from a neighbouring bucket would report someone else's run as theirs.
    const runs = mergeOrchestratorRuns(
      [
        charge({ id: 'looked', workflowId: '11579707-20260529164941242' }),
        charge({ id: 'skipped', workflowId: '11579707-20260101000000000' }),
      ],
      [],
      [job()],
      [],
      baseModels
    );
    expect(runs.looked?.epochs).toBe(10);
    expect(runs.skipped).toBeUndefined();
  });

  it('sums every refund carrying the workflow id of the run', () => {
    // One workflow can be refunded more than once; taking the first row would under-report those.
    const runs = mergeOrchestratorRuns(
      [charge()],
      [],
      [job()],
      [refund(200), refund(300)],
      baseModels
    );
    expect(runs.tx?.refunded).toBe(500);
  });

  it('reports zero refunded, not unknown, when the ledger shows none', () => {
    const runs = mergeOrchestratorRuns([charge()], [], [job()], [], baseModels);
    expect(runs.tx?.refunded).toBe(0);
  });

  it('does not credit a refund belonging to a different run', () => {
    const runs = mergeOrchestratorRuns(
      [charge()],
      [],
      [job()],
      [refund(500, '11579707-20260101000000000')],
      baseModels
    );
    expect(runs.tx?.refunded).toBe(0);
  });

  it('surfaces a refunded run even when neither orchestration table has anything', () => {
    // The refund is the whole answer to "did they get their Buzz back", and it outlives both tables.
    const runs = mergeOrchestratorRuns([charge()], [], [], [refund(500)], baseModels);
    expect(runs.tx).toMatchObject({ refunded: 500, epochs: null, status: null });
  });

  it('leaves refunded unknown when the charge carries no workflow id to join on', () => {
    const runs = mergeOrchestratorRuns(
      [charge({ workflowId: null })],
      [],
      [job()],
      [refund(500)],
      baseModels
    );
    expect(runs.tx?.refunded).toBeNull();
  });

  it('flags a bucket holding a second workflow that is not a charge at all', () => {
    // The collision that counting charges cannot see: the account was generating in the second it
    // submitted this training. Two Gate jobs means two workflows landed here, and the figures cover
    // both — reporting them as this run's is how a refund gets decided on someone else's jobs.
    const runs = mergeOrchestratorRuns(
      [charge()],
      [],
      [job(), job({ jobType: 'Gate', jobs: 2, cost: 0, provider: '', resources: [] })],
      [],
      baseModels
    );
    expect(runs.tx?.ambiguous).toBe(true);
  });

  it('leaves a single-workflow bucket unambiguous', () => {
    const runs = mergeOrchestratorRuns(
      [charge()],
      [],
      [job(), job({ jobType: 'Gate', jobs: 1, cost: 0, provider: '', resources: [] })],
      [],
      baseModels
    );
    expect(runs.tx?.ambiguous).toBe(false);
  });

  it('zone-marks the last job time, which ClickHouse hands back unzoned UTC', () => {
    // Same trap as `unaccountedCharges`: without the marker every timestamp renders shifted by the
    // viewer's offset, and a run reads as finishing hours from the charge that started it.
    const runs = mergeOrchestratorRuns([charge()], [], [job()], [], baseModels);
    expect(runs.tx?.lastJobAt).toBe('2026-05-29T17:57:45Z');
  });
});
