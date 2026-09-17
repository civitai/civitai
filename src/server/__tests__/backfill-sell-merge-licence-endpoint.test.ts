import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelSchema from '~/server/schema/model.schema';

/**
 * Three properties here have no other gate, and each is pinned by its failure rather than by
 * coverage — revert any one of them and a named assertion reddens.
 *
 * 1. The UPDATE does not assign `updatedAt`. That is a deliberate omission, not an oversight: raw
 *    SQL bypasses Prisma's `@updatedAt`, so the bump exists exactly when someone types the line, and
 *    the sibling endpoint `backfill-trained-model-permissions.ts` DOES type it. A test asserting
 *    "updatedAt unchanged" would pass trivially against a row that never moved, so the same case
 *    asserts the array gained the member.
 * 2. The cutoff and the licence predicate are re-checked INSIDE the UPDATE, not only in the SELECT
 *    that built the batch. A creator editing a row in between has made a deliberate choice, and the
 *    only thing standing between that choice and this backfill is the WHERE clause on the write.
 * 3. The write-path gate refuses. Both arms are exercised — a contract that accepts the value
 *    proceeds, one that rejects it 409s and writes nothing — because a guard whose failing path has
 *    never run is not known to have one.
 */

const { env, queueUpdate, rejectSellMerge } = vi.hoisted(() => ({
  env: {
    WEBHOOK_TOKEN: 'test-token',
    LOGGING: '',
    NEXTAUTH_URL: 'https://example.test',
    TRPC_ORIGINS: [] as string[],
  },
  queueUpdate: vi.fn(async () => undefined),
  rejectSellMerge: { value: false },
}));

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate } }));

// Spread the real module: the endpoint's gate is the REAL `model.upsert` contract, and a hand-listed
// stub would make the passing arm prove nothing about it. Only `safeParse` is steerable, and only so
// the refusing arm can be reached without a deploy.
vi.mock('~/server/schema/model.schema', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelSchema>();
  return {
    ...actual,
    modelUpsertSchema: {
      ...actual.modelUpsertSchema,
      safeParse: (value: unknown) =>
        rejectSellMerge.value ? { success: false } : actual.modelUpsertSchema.safeParse(value),
    },
  };
});

const endpoint = await import('~/pages/api/admin/temp/backfill-sell-merge-licence');
const handler = endpoint.default;
const { contractAcceptsSellMerge } = endpoint;

const CUTOFF = '2026-09-17 03:11:25';

function call(query: Record<string, string>, { method = 'POST', token = 'test-token' } = {}) {
  const req = { method, query: { token, ...query }, headers: {} } as never;
  let statusCode = 0;
  let payload: Record<string, unknown> | undefined;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: Record<string, unknown>) {
      payload = data;
      return res;
    },
    send: () => res,
    setHeader: () => res,
    end: () => res,
  };
  return handler(req, res as never).then(() => ({
    statusCode,
    payload: payload as Record<string, unknown>,
  }));
}

const sqlTextOf = (calls: unknown[][], index = 0) =>
  (calls[index][0] as unknown as string[]).join(' $ ');
const sqlValuesOf = (calls: unknown[][], index = 0) => calls[index].slice(1);

const rows = (ids: number[]) => ids.map((id) => ({ id }));

describe('backfill-sell-merge-licence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset, not clear: clearAllMocks leaves a queued mockResolvedValueOnce behind, and a leaked
    // once-value surfaces in the NEXT test, which misattributes the cause.
    dbMock.dbRead.$queryRaw.mockReset();
    dbMock.dbWrite.$queryRaw.mockReset();
    dbMock.dbRead.$queryRaw.mockResolvedValue(rows([5, 6, 7]));
    dbMock.dbWrite.$queryRaw.mockResolvedValue(rows([5, 6, 7]));
    rejectSellMerge.value = false;
  });

  it('rejects a call with the wrong token, and reads nothing', async () => {
    const { statusCode } = await call({}, { token: 'wrong' });

    expect(statusCode).toBe(401);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a live run that is not a POST', async () => {
    const { statusCode } = await call({ dryRun: 'false' }, { method: 'GET' });

    expect(statusCode).toBe(405);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('dry runs by default: selects, writes nothing, queues nothing', async () => {
    const { statusCode, payload } = await call({}, { method: 'GET' });

    expect(statusCode).toBe(200);
    expect(payload.dryRun).toBe(true);
    expect(payload.totalSelected).toBe(3);
    expect(payload.nextAfterId).toBe(7);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('adds SellMerge without assigning updatedAt, and the row does move', async () => {
    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(200);
    // The write happened: asserting the absence of an updatedAt bump against a row that never
    // moved would pass forever.
    expect(payload.totalChanged).toBe(3);
    expect(payload.changedIds).toEqual([5, 6, 7]);

    const sql = sqlTextOf(dbMock.dbWrite.$queryRaw.mock.calls);
    expect(sql).toContain(`"allowCommercialUse" = m."allowCommercialUse" || ARRAY['SellMerge']`);
    // Revert guard: re-adding the sibling endpoint's `"updatedAt" = CASE WHEN … NOW() END` line
    // fails here by name instead of silently freezing every touched row out of a second run.
    expect(sql).not.toMatch(/"updatedAt"\s*=[^=]/);
  });

  it('re-checks the cutoff and the licence predicate inside the UPDATE, not only in the SELECT', async () => {
    await call({ dryRun: 'false' });

    const sql = sqlTextOf(dbMock.dbWrite.$queryRaw.mock.calls);
    expect(sql).toContain(`"allowCommercialUse" @> ARRAY['Sell']`);
    expect(sql).toContain(`NOT (m."allowCommercialUse" @> ARRAY['SellMerge']`);
    expect(sql).toContain('"updatedAt" <');
    expect(sqlValuesOf(dbMock.dbWrite.$queryRaw.mock.calls)).toContain(CUTOFF);
  });

  it('pages by keyset and never by offset', async () => {
    await call({ afterId: '4000' }, { method: 'GET' });

    const sql = sqlTextOf(dbMock.dbRead.$queryRaw.mock.calls);
    expect(sql).toContain('m.id >');
    expect(sql).toContain('ORDER BY m.id');
    expect(sql).not.toContain('OFFSET');
    expect(sqlValuesOf(dbMock.dbRead.$queryRaw.mock.calls)).toContain(4000);
  });

  it('reports a row the UPDATE declined, and queues only the rows that moved', async () => {
    // 6 was edited between the read and the write, so the re-checked WHERE drops it.
    dbMock.dbWrite.$queryRaw.mockResolvedValue(rows([5, 7]));

    const { payload } = await call({ dryRun: 'false' });

    expect(payload.totalSelected).toBe(3);
    expect(payload.totalChanged).toBe(2);
    expect(payload.declinedIds).toEqual([6]);
    expect(queueUpdate).toHaveBeenCalledWith([
      { id: 5, action: 'Update' },
      { id: 7, action: 'Update' },
    ]);
  });

  it('queues nothing when the UPDATE moved nothing', async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);

    const { payload } = await call({ dryRun: 'false' });

    expect(payload.totalChanged).toBe(0);
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('advances the cursor past a declined row so the run cannot stall on it', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue(rows([5, 6, 7]));
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);

    const { payload } = await call({ dryRun: 'false' });

    // The cursor comes from the batch, not from what moved: taking it from `changedIds` would leave
    // an all-declined batch returning its own afterId and every later call re-reading it.
    expect(payload.nextAfterId).toBe(7);
  });

  it('refuses a live run when the live build rejects SellMerge at model.upsert', async () => {
    rejectSellMerge.value = true;

    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(409);
    expect(String(payload.error)).toContain('rejects SellMerge');
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('still dry runs while the gate refuses, and says so', async () => {
    rejectSellMerge.value = true;

    const { statusCode, payload } = await call({}, { method: 'GET' });

    // Sizing the set is the one thing an operator wants before the write paths are open.
    expect(statusCode).toBe(200);
    expect(payload.contractAcceptsSellMerge).toBe(false);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('distinguishes a contract that accepts the value from one that rejects it', () => {
    expect(contractAcceptsSellMerge()).toBe(true);
    expect(contractAcceptsSellMerge({ safeParse: () => ({ success: false }) })).toBe(false);
  });
});
