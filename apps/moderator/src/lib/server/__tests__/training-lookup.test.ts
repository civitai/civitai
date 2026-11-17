import { beforeEach, describe, expect, it, vi } from 'vitest';

const WF_A = '1001-20261001120000123';
const WF_B = '1002-20261002130000456';

type Route = (query: string) => unknown[] | Promise<unknown[]>;
let routes: { match: string; rows: Route }[];
const chQuery = vi.fn(async (query: string) => {
  const route = routes.find((r) => query.includes(r.match));
  return route ? route.rows(query) : [];
});
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({ $query: chQuery }) }));

// Replica rows answer the `ModelVersion.meta` read, primary rows the `ModelFile` fallback.
let replicaRows: () => unknown[];
let primaryRows: () => unknown[];
vi.mock('$lib/server/db', () => {
  const chain = (rows: () => unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const method of ['innerJoin', 'leftJoin', 'select', 'where']) self[method] = () => self;
    self.execute = async () => rows();
    return self;
  };
  return {
    dbRead: { selectFrom: () => chain(() => replicaRows()) },
    dbWrite: { selectFrom: () => chain(() => primaryRows()) },
  };
});
vi.mock('$lib/server/training-moderation.service', () => ({
  TRAINING_DATA_FILE_TYPE: 'Training Data',
}));

const { lookupTrainings, getAccountTrainings } = await import('../training-lookup.service');

const CHARGE = "type = 'training'";
const REFUND = "type = 'refund'";
const JOBS = 'orchestration.jobs';
const fail = () => {
  throw new Error('down');
};
const charge = (payer: number, accountType: string, amount: number) => ({
  id: `tx-${Math.random()}`,
  date: '2026-10-01 12:00:01',
  payer: String(payer),
  accountType,
  amount: String(amount),
});
/** A run as the account query returns it: grouped, one row per run with its legs. */
const run = (payer: number, workflowId: string, legs: [string, number][] = [['yellow', 500]]) => ({
  payer: String(payer),
  workflowId,
  chargedAt: '2026-10-01 12:00:01',
  types: legs.map(([t]) => t),
  amounts: legs.map(([, a]) => String(a)),
});
/** The job bucket of a run submitted at WF_A's stamp. */
const bucket = (userId: number) => ({
  userId: String(userId),
  second: '2026-10-01 12:00:00',
  jobType: 'AIToolkitTrainingEpoch',
  jobs: '10',
  cost: 1,
  provider: 'p',
  lastCompletedAt: '2026-10-01 14:00:00',
  resources: [],
});

beforeEach(() => {
  chQuery.mockClear();
  routes = [];
  replicaRows = () => [];
  primaryRows = () => [];
});

describe('lookupTrainings', () => {
  it('reads a training_-prefixed id as the workflow id it wraps', async () => {
    routes = [{ match: CHARGE, rows: () => [charge(1001, 'yellow', 500)] }];
    const { runs, invalid } = await lookupTrainings([`training_${WF_A}`]);
    expect(invalid).toEqual([]);
    expect(runs[0]).toMatchObject({ workflowId: WF_A, submitterId: 1001 });
    const chargeQuery = chQuery.mock.calls.map(([q]) => q).find((q) => q.includes(CHARGE))!;
    expect(chargeQuery).toContain(`= '${WF_A}'`);
  });

  it('never queries an id that is not a workflow id', async () => {
    const bad = "1001-2026' OR 1=1 --";
    const { runs, invalid } = await lookupTrainings([bad, 'training_abc']);
    expect(invalid).toEqual([bad, 'training_abc']);
    expect(runs).toEqual([]);
    expect(chQuery).not.toHaveBeenCalled();
  });

  it('splits a run paid from two Buzz account types into two legs', async () => {
    routes = [
      { match: CHARGE, rows: () => [charge(1001, 'blue', 300), charge(1001, 'yellow', 200)] },
    ];
    const [run] = (await lookupTrainings([WF_A])).runs;
    expect(run.charge.legs).toEqual([
      { accountType: 'blue', amount: 300 },
      { accountType: 'yellow', amount: 200 },
    ]);
    expect(run.charge.buzz).toBe(500);
  });

  it('flags a run paid by an account other than its submitter', async () => {
    routes = [{ match: CHARGE, rows: () => [charge(2002, 'blue', 500)] }];
    const [run] = (await lookupTrainings([WF_A])).runs;
    expect(run.submitterId).toBe(1001);
    expect(run.charge.payerId).toBe(2002);
  });

  it('tells a failed ledger read apart from an empty one', async () => {
    routes = [{ match: CHARGE, rows: () => [] }];
    expect((await lookupTrainings([WF_A])).runs[0].charge.status).toBe('notFound');
    routes = [
      {
        match: CHARGE,
        rows: () => {
          throw new Error('down');
        },
      },
    ];
    expect((await lookupTrainings([WF_A])).runs[0].charge.status).toBe('unreachable');
  });

  it('reads charges and refunds in separate queries', async () => {
    routes = [{ match: CHARGE, rows: () => [charge(1001, 'yellow', 500)] }];
    await lookupTrainings([WF_A]);
    const queries = chQuery.mock.calls.map(([q]) => q);
    expect(queries.some((q) => q.includes(REFUND))).toBe(true);
    expect(queries.filter((q) => q.includes(CHARGE) && q.includes(REFUND))).toEqual([]);
  });

  it("sums the refunds paid back to the run's payer", async () => {
    routes = [
      { match: CHARGE, rows: () => [charge(2002, 'yellow', 500)] },
      {
        match: REFUND,
        rows: (q) =>
          q.includes('toAccountId = 2002') ? [{ amount: '200' }, { amount: '100' }] : [],
      },
    ];
    expect((await lookupTrainings([WF_A])).runs[0].charge.refunded).toBe(300);
  });

  it('reads refunded as 0 when none was found and null when the refund read failed', async () => {
    routes = [{ match: CHARGE, rows: () => [charge(1001, 'yellow', 500)] }];
    expect((await lookupTrainings([WF_A])).runs[0].charge.refunded).toBe(0);
    routes.push({ match: REFUND, rows: fail });
    expect((await lookupTrainings([WF_A])).runs[0].charge.refunded).toBeNull();
  });
});

describe('getAccountTrainings', () => {
  it('caps runs, not legs: a run paid in two legs counts once', async () => {
    routes = [
      {
        match: CHARGE,
        rows: () => [
          run(1001, WF_A, [
            ['blue', 300],
            ['yellow', 200],
          ]),
        ],
      },
    ];
    const out = await getAccountTrainings([1001], 30);
    const chargeQuery = chQuery.mock.calls.map(([q]) => q).find((q) => q.includes(CHARGE))!;
    expect(chargeQuery).toMatch(/GROUP BY payer, workflowId/);
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0].charge.legs).toEqual([
      { accountType: 'blue', amount: 300 },
      { accountType: 'yellow', amount: 200 },
    ]);
  });

  it('keeps a malformed workflow id from the ledger out of every later query', async () => {
    const hostile = "1001-20261001120000') OR 1=1 --";
    routes = [{ match: CHARGE, rows: () => [run(1001, hostile), run(1001, WF_A)] }];
    const out = await getAccountTrainings([1001], 30);
    expect(out.runs.map((r) => r.workflowId)).toEqual([WF_A]);
    expect(out.unlinkedCharges).toEqual({ 1001: 1 });
    const later = chQuery.mock.calls.map(([q]) => q).filter((q) => !q.includes(CHARGE));
    expect(later.length).toBeGreaterThan(0);
    for (const q of later) expect(q).not.toContain('OR 1=1');
  });

  it('caps the list at 500 runs and says it was truncated', async () => {
    routes = [
      {
        match: CHARGE,
        rows: () =>
          Array.from({ length: 501 }, (_, i) =>
            run(1001, `1001-202610011200${String(i).padStart(5, '0')}`)
          ),
      },
    ];
    const out = await getAccountTrainings([1001], 30);
    expect(out.truncated).toBe(true);
    expect(out.runs).toHaveLength(500);
  });

  it('names the listed submitter of a run another listed account paid for', async () => {
    routes = [
      {
        match: CHARGE,
        rows: () => [run(1001, WF_B), run(1001, WF_A)],
      },
    ];
    const out = await getAccountTrainings([1001, 1002], 30);
    const byId = Object.fromEntries(out.runs.map((r) => [r.workflowId, r.sharedWith]));
    expect(byId).toEqual({ [WF_B]: 1002, [WF_A]: null });
  });

  it('reads refunds in a query of their own and nets them per run', async () => {
    routes = [
      { match: CHARGE, rows: () => [run(1001, WF_A)] },
      { match: REFUND, rows: () => [{ workflowId: WF_A, amount: '500' }] },
    ];
    const out = await getAccountTrainings([1001], 30);
    expect(out.runs[0].charge.refunded).toBe(500);
    const queries = chQuery.mock.calls.map(([q]) => q);
    expect(queries.filter((q) => q.includes(CHARGE) && q.includes(REFUND))).toEqual([]);
  });

  it('reads refunded as 0 when none was found and null when the refund read failed', async () => {
    routes = [{ match: CHARGE, rows: () => [run(1001, WF_A)] }];
    expect((await getAccountTrainings([1001], 30)).runs[0].charge.refunded).toBe(0);
    routes.push({ match: REFUND, rows: fail });
    expect((await getAccountTrainings([1001], 30)).runs[0].charge.refunded).toBeNull();
  });

  it('reports an unreadable ledger as unreachable, not as no trainings', async () => {
    routes = [
      {
        match: CHARGE,
        rows: () => {
          throw new Error('down');
        },
      },
    ];
    const out = await getAccountTrainings([1001], 30);
    expect(out.reachable).toBe(false);
  });
});

describe('model version', () => {
  const lookUp = async () => (await lookupTrainings([WF_A])).runs[0].version;
  beforeEach(() => {
    routes = [{ match: CHARGE, rows: () => [charge(1001, 'yellow', 500)] }];
  });

  it('reads the version from ModelVersion.meta on the replica', async () => {
    replicaRows = () => [{ modelVersionId: 11, modelId: 12, workflowId: WF_A }];
    primaryRows = fail;
    expect(await lookUp()).toEqual({
      status: 'found',
      source: 'ModelVersion.meta',
      modelVersionId: 11,
      modelId: 12,
    });
  });

  it('falls back to the training file on the primary when meta has no match', async () => {
    primaryRows = () => [{ modelVersionId: 21, modelId: 22, workflowId: WF_A }];
    expect(await lookUp()).toEqual({
      status: 'found',
      source: 'ModelFile.metadata',
      modelVersionId: 21,
      modelId: 22,
    });
  });

  it('is notFound when neither has the run, and unreachable when the read fails', async () => {
    expect((await lookUp()).status).toBe('notFound');
    replicaRows = fail;
    expect((await lookUp()).status).toBe('unreachable');
  });
});

describe('completion', () => {
  const lookUp = async () => (await lookupTrainings([WF_A])).runs[0].completion;
  beforeEach(() => {
    routes = [{ match: CHARGE, rows: () => [charge(1001, 'yellow', 500)] }];
  });

  it("takes the last job time from the submitter's bucket at the submit second", async () => {
    routes.push({ match: JOBS, rows: () => [bucket(1001)] });
    expect(await lookUp()).toMatchObject({
      status: 'found',
      lastJobAt: '2026-10-01T14:00:00Z',
      ambiguous: false,
    });
  });

  it("does not read another account's bucket in the same second as this run's", async () => {
    routes.push({ match: JOBS, rows: () => [bucket(3003)] });
    expect((await lookUp()).status).toBe('notFound');
  });

  it('is unreachable when the jobs read fails', async () => {
    routes.push({ match: JOBS, rows: fail });
    expect((await lookUp()).status).toBe('unreachable');
  });
});
