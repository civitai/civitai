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

let versionRows: unknown[];
vi.mock('$lib/server/db', () => {
  const chain = (rows: () => unknown[]) => {
    const self: Record<string, unknown> = {};
    for (const method of ['innerJoin', 'leftJoin', 'select', 'where']) self[method] = () => self;
    self.execute = async () => rows();
    return self;
  };
  return {
    dbRead: { selectFrom: () => chain(() => versionRows) },
    dbWrite: { selectFrom: () => chain(() => []) },
  };
});
vi.mock('$lib/server/training-moderation.service', () => ({
  TRAINING_DATA_FILE_TYPE: 'Training Data',
}));

const { lookupTrainings, getAccountTrainings } = await import('../training-lookup.service');

const CHARGE = "type = 'training'";
const REFUND = "type = 'refund'";
const charge = (payer: number, accountType: string, amount: number, workflowId = '') => ({
  id: `tx-${Math.random()}`,
  date: '2026-10-01 12:00:01',
  payer: String(payer),
  accountType,
  amount: String(amount),
  workflowId,
});

beforeEach(() => {
  chQuery.mockClear();
  routes = [];
  versionRows = [];
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
});

describe('getAccountTrainings', () => {
  it('caps the list at 500 runs and says it was truncated', async () => {
    routes = [
      {
        match: CHARGE,
        rows: () =>
          Array.from({ length: 501 }, (_, i) =>
            charge(1001, 'yellow', 100, `1001-202610011200${String(i).padStart(5, '0')}`)
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
        rows: () => [charge(1001, 'blue', 500, WF_B), charge(1001, 'blue', 500, WF_A)],
      },
    ];
    const out = await getAccountTrainings([1001, 1002], 30);
    const byId = Object.fromEntries(out.runs.map((r) => [r.workflowId, r.sharedWith]));
    expect(byId).toEqual({ [WF_B]: 1002, [WF_A]: null });
  });

  it('reads refunds in a query of their own and nets them per run', async () => {
    routes = [
      { match: CHARGE, rows: () => [charge(1001, 'yellow', 500, WF_A)] },
      { match: REFUND, rows: () => [{ workflowId: WF_A, amount: '500' }] },
    ];
    const out = await getAccountTrainings([1001], 30);
    expect(out.runs[0].charge.refunded).toBe(500);
    const queries = chQuery.mock.calls.map(([q]) => q);
    expect(queries.filter((q) => q.includes(CHARGE) && q.includes(REFUND))).toEqual([]);
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
