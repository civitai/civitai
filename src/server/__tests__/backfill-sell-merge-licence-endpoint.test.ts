import { beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ModelSchema from '~/server/schema/model.schema';

/**
 * Properties with no other gate, each pinned by a named failure rather than by coverage. Revert any
 * one and the assertion that carries it reddens on its own.
 *
 * 1. The UPDATE does not assign `updatedAt`. Raw SQL bypasses Prisma's `@updatedAt`, so the bump
 *    exists exactly when someone types the line — and the sibling `backfill-trained-model-permissions`
 *    DOES type it. Asserting "updatedAt unchanged" alone would pass against a row that never moved, so
 *    the same case asserts the array gained the member.
 * 2. The write is bounded to the batch. Deleting `id = ANY(...)` does not write outside the population
 *    — the licence predicate is still there — it writes the WHOLE population in one statement while
 *    the response and the enqueue name only the first batch, so ~422k licences move with no route into
 *    the search index. The ids bound to the write are asserted, not just the operator's presence.
 * 3. Read and write share ONE predicate. Both SQL texts must contain the same block, including the
 *    `::timestamp` cast — a `timestamptz` comparand would be rendered through the connection's
 *    TimeZone and move the cutoff silently.
 * 4. The write-path gate refuses in both ways it can be wrong: a contract that REJECTS the member, and
 *    one that silently STRIPS it. The second is the shape a future hold-back would take, and a
 *    `.success` check cannot see it.
 * 5. `exhausted` is asserted both ways. It is the flag the operator's outside loop stops on.
 */

const { env, queueUpdate, contractMode } = vi.hoisted(() => ({
  env: {
    WEBHOOK_TOKEN: 'test-token',
    LOGGING: '',
    NEXTAUTH_URL: 'https://example.test',
    TRPC_ORIGINS: [] as string[],
  },
  queueUpdate: vi.fn(async () => undefined),
  contractMode: { value: 'real' as 'real' | 'reject' | 'strip' },
}));

vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate } }));

// Spread the real module: the endpoint's gate is the REAL `model.upsert` contract, and a hand-listed
// stub would make the passing arm prove nothing about it. Only `safeParse` is steerable, and only so
// the two refusing arms can be reached without a deploy.
vi.mock('~/server/schema/model.schema', async (importOriginal) => {
  const actual = await importOriginal<typeof ModelSchema>();
  return {
    ...actual,
    modelUpsertSchema: {
      ...actual.modelUpsertSchema,
      safeParse: (value: unknown) => {
        if (contractMode.value === 'reject') return { success: false };
        const parsed = actual.modelUpsertSchema.safeParse(value);
        if (contractMode.value === 'strip' && parsed.success) {
          return {
            success: true,
            data: {
              ...parsed.data,
              allowCommercialUse: (parsed.data.allowCommercialUse ?? []).filter(
                (v) => v !== 'SellMerge'
              ),
            },
          };
        }
        return parsed;
      },
    },
  };
});

const endpoint = await import('~/pages/api/admin/temp/backfill-sell-merge-licence');
const handler = endpoint.default;
const { contractAcceptsSellMerge, WRITE_PATH_PROBE } = endpoint;
const { modelUpsertSchema } = await import('~/server/schema/model.schema');

const CUTOFF = '2026-09-16 21:49:42';
const PREDICATE_BLOCK =
  `m."allowCommercialUse" @> ARRAY['Sell']::"CommercialUse"[] ` +
  `AND NOT (m."allowCommercialUse" @> ARRAY['SellMerge']::"CommercialUse"[]) ` +
  `AND m."updatedAt" <`;

function call(
  query: Record<string, string>,
  { method = 'POST', token = 'test-token', omitBatchSize = false } = {}
) {
  const base: Record<string, string> = omitBatchSize ? { token } : { token, batchSize: '3' };
  const req = { method, query: { ...base, ...query }, headers: {} } as never;
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

// Collapsed whitespace, so an assertion about SQL STRUCTURE — which clause joins to which, and by
// what connective — survives a re-indent of the statement instead of failing on it.
const flat = (calls: unknown[][], index = 0) => sqlTextOf(calls, index).replace(/\s+/g, ' ').trim();

// The shared predicate reaches `$queryRaw` as an interpolated `Prisma.Sql` VALUE, not as text in the
// template, so the mock sees the object itself — which is what makes the identity assertion possible.
// Returned as a LIST: `.find()` would silently pick the first of several fragments, so the identity
// assertion could end up comparing the wrong object, or `undefined` to `undefined`, and pass.
const isSql = (v: unknown): v is { strings: string[]; values: unknown[] } =>
  !!v && typeof v === 'object' && Array.isArray((v as { strings?: unknown }).strings);
const predicatesOf = (calls: unknown[][], index = 0) => sqlValuesOf(calls, index).filter(isSql);

describe('backfill-sell-merge-licence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset, not clear: clearAllMocks leaves a queued mockResolvedValueOnce behind, and a leaked
    // once-value surfaces in the NEXT test, which misattributes the cause.
    dbMock.dbRead.$queryRaw.mockReset();
    dbMock.dbWrite.$queryRaw.mockReset();
    dbMock.dbRead.$queryRaw.mockResolvedValue(rows([5, 6, 7]));
    dbMock.dbWrite.$queryRaw.mockResolvedValue(rows([5, 6, 7]));
    queueUpdate.mockResolvedValue(undefined);
    contractMode.value = 'real';
  });

  it('rejects a call with the wrong token, and reads nothing', async () => {
    const { statusCode } = await call({}, { token: 'wrong' });

    expect(statusCode).toBe(401);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a call that states no batchSize, rather than inheriting one', async () => {
    // The parameter is ABSENT, not empty: `z.coerce.number()` turns '' into 0 and the min(1) bound
    // rejects that even with a default present, so an empty-string case cannot see a default at all.
    // The pace of this run is an operational decision, and a default would answer it by omission.
    const { statusCode, payload } = await call({}, { method: 'GET', omitBatchSize: true });

    expect(statusCode).toBe(400);
    expect(String(payload.error)).toContain('batchSize is required');
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a batchSize past the typo bound', async () => {
    const { statusCode } = await call({ batchSize: '50000' }, { method: 'GET' });

    expect(statusCode).toBe(400);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a live run that is not a POST, before reading anything', async () => {
    const { statusCode } = await call({ dryRun: 'false' }, { method: 'GET' });

    expect(statusCode).toBe(405);
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('dry runs by default: selects, writes nothing, queues nothing', async () => {
    const { statusCode, payload } = await call({}, { method: 'GET' });

    expect(statusCode).toBe(200);
    expect(payload.dryRun).toBe(true);
    expect(payload.cutoff).toBe(CUTOFF);
    expect(payload.totalSelected).toBe(3);
    expect(payload.nextAfterId).toBe(7);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('adds SellMerge without assigning updatedAt, and the row does move', async () => {
    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(200);
    // The write happened: asserting the absence of an updatedAt bump against a row that never moved
    // would pass forever.
    expect(payload.totalChanged).toBe(3);
    expect(payload.changedIds).toEqual([5, 6, 7]);

    const sql = sqlTextOf(dbMock.dbWrite.$queryRaw.mock.calls);
    expect(sql).toContain(`"allowCommercialUse" = m."allowCommercialUse" || ARRAY['SellMerge']`);
    // Revert guard: re-adding the sibling endpoint's `"updatedAt" = CASE WHEN … NOW() END` line fails
    // here by name.
    expect(sql).not.toMatch(/"updatedAt"\s*=[^=]/);
  });

  it('bounds the write to the ids the batch selected', async () => {
    await call({ dryRun: 'false' });

    // The whole WHERE shape, not the operator's presence: the id bound is only a bound while it is
    // ANDed to the predicate. Turn that AND into an OR and every fragment-level assertion still
    // passes while the statement rewrites the entire population in one go.
    expect(flat(dbMock.dbWrite.$queryRaw.mock.calls)).toContain(
      'WHERE m.id = ANY( $ ::int[]) AND $ RETURNING m.id'
    );
    // The ids themselves, so the bound cannot be present but empty or wrong.
    expect(sqlValuesOf(dbMock.dbWrite.$queryRaw.mock.calls)).toContainEqual([5, 6, 7]);

    // ONE statement. Every other write assertion reads call 0, so a second UPDATE appended after this
    // one — or the sibling's `updatedAt` bump issued separately, or through `$executeRaw` — would be
    // invisible to all of them.
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  it('re-checks one identical predicate in the UPDATE and the SELECT, cast in the column terms', async () => {
    await call({ dryRun: 'false' });

    const readPredicates = predicatesOf(dbMock.dbRead.$queryRaw.mock.calls);
    const writePredicates = predicatesOf(dbMock.dbWrite.$queryRaw.mock.calls);

    // Exactly one fragment each, asserted before the identity comparison: two `undefined`s are `toBe`
    // each other, so a lookup that found nothing would otherwise read as agreement.
    expect(readPredicates).toHaveLength(1);
    expect(writePredicates).toHaveLength(1);
    const [readPredicate] = readPredicates;

    // Identity, not two matching texts: the safety argument is that the write's WHERE IS the read's,
    // and this is the assertion that a second hand-written copy cannot satisfy. It is deliberately
    // brittle to wrapping the fragment (`Prisma.sql`(${legacySellWithoutMerge})``) — that would be a
    // true statement and a red test. Keep the identity rather than relaxing it to two text compares.
    expect(writePredicates[0]).toBe(readPredicate);

    // The whole block, not three fragments: a fragment set cannot see an AND turned into an OR inside
    // the predicate, and an OR there would grant the member to exactly the post-cutoff rows whose
    // creator declined it. Whitespace is collapsed so a re-indent of the const is not a false red.
    const text = readPredicate.strings.join(' $ ').replace(/\s+/g, ' ');
    expect(text).toContain(PREDICATE_BLOCK);
    expect(text).toContain('::timestamp');
    // `toContain('::timestamp')` is satisfied by `::timestamptz` as a substring, and a timestamptz
    // comparand against a zone-free column is rendered through the connection's TimeZone.
    expect(text).not.toContain('::timestamptz');
    expect(readPredicate.values).toContain(CUTOFF);
  });

  it('pages by keyset, bounded by the stated batchSize, never by offset', async () => {
    await call({ afterId: '4000', batchSize: '1200' }, { method: 'GET' });

    expect(flat(dbMock.dbRead.$queryRaw.mock.calls)).toContain(
      'WHERE $ AND m.id > $ ORDER BY m.id LIMIT $'
    );
    expect(flat(dbMock.dbRead.$queryRaw.mock.calls)).not.toContain('OFFSET');

    // ORDER, not membership: `toContain(4000)` and `toContain(1200)` both hold with the two
    // interpolations swapped, which would page from `id > 1200` in batches of 4,000 — skipping rows
    // and running at four times the pace the operator stated.
    const numbers = sqlValuesOf(dbMock.dbRead.$queryRaw.mock.calls).filter(
      (v) => typeof v === 'number'
    );
    expect(numbers).toEqual([4000, 1200]);
  });

  it('reports a row the UPDATE declined, and queues only the rows that moved, once', async () => {
    // 6 was edited between the read and the write, so the re-checked WHERE drops it.
    dbMock.dbWrite.$queryRaw.mockResolvedValue(rows([5, 7]));

    const { payload } = await call({ dryRun: 'false' });

    expect(payload.totalSelected).toBe(3);
    expect(payload.totalChanged).toBe(2);
    expect(payload.declinedIds).toEqual([6]);
    expect(queueUpdate).toHaveBeenCalledTimes(1);
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
    dbMock.dbWrite.$queryRaw.mockResolvedValue([]);

    const { payload } = await call({ dryRun: 'false' });

    // The cursor comes from the batch, not from what moved: taking it from `changedIds` would leave an
    // all-declined batch returning its own afterId and every later call re-reading it.
    expect(payload.nextAfterId).toBe(7);
  });

  it('logs the changed ids before the enqueue, so a failing enqueue cannot erase the record', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    queueUpdate.mockRejectedValue(new Error('sysRedis down'));

    await expect(call({ dryRun: 'false' })).rejects.toThrow('sysRedis down');

    const ours = log.mock.calls.findIndex((args) =>
      String(args[0]).startsWith('backfill-sell-merge-licence:')
    );
    expect(ours).toBeGreaterThanOrEqual(0);
    expect(String(log.mock.calls[ours][0])).toContain('ids 5,6,7');
    // Ordering is the property, not the presence: the log has to precede the enqueue, or a rejecting
    // enqueue takes the only record of the write down with it.
    expect(log.mock.invocationCallOrder[ours]).toBeLessThan(
      queueUpdate.mock.invocationCallOrder[0]
    );
    log.mockRestore();
  });

  it('reports exhausted on a short batch and not on a full one', async () => {
    const short = await call({ batchSize: '10' }, { method: 'GET' });
    expect(short.payload.totalSelected).toBe(3);
    expect(short.payload.exhausted).toBe(true);

    const full = await call({ batchSize: '3' }, { method: 'GET' });
    expect(full.payload.exhausted).toBe(false);
  });

  it('answers the terminal live call without issuing an UPDATE at all', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);

    const { statusCode, payload } = await call({ afterId: '900', dryRun: 'false' });

    expect(statusCode).toBe(200);
    expect(payload.exhausted).toBe(true);
    expect(payload.totalChanged).toBe(0);
    expect(payload.nextAfterId).toBe(900);
    // `id = ANY('{}')` is a pointless round-trip on the one call that reports the run finished, and a
    // throw there reads as the run having failed.
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('refuses a live run when the build rejects SellMerge at model.upsert', async () => {
    contractMode.value = 'reject';

    const { statusCode, payload } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(409);
    expect(String(payload.error)).toContain('SellMerge');
    expect(dbMock.dbRead.$queryRaw).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('refuses a live run when the build STRIPS SellMerge instead of rejecting it', async () => {
    // The shape a future hold-back would take. It parses cleanly, so a `.success` check reads the
    // write paths as open while every creator's next save reverts the member.
    contractMode.value = 'strip';

    const { statusCode } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(409);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('still dry runs while the gate refuses, and says so', async () => {
    contractMode.value = 'reject';

    const { statusCode, payload } = await call({}, { method: 'GET' });

    // Sizing the set is the one thing an operator wants before the write paths are open.
    expect(statusCode).toBe(200);
    expect(payload.contractAcceptsSellMerge).toBe(false);
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('distinguishes a contract that keeps the member from ones that reject or strip it', () => {
    expect(contractAcceptsSellMerge()).toBe(true);
    expect(contractAcceptsSellMerge({ safeParse: () => ({ success: false }) })).toBe(false);
    expect(
      contractAcceptsSellMerge({
        safeParse: () => ({ success: true, data: { allowCommercialUse: ['Sell'] } }),
      })
    ).toBe(false);
  });

  it('probes a contract that genuinely validates the member', () => {
    // Without this the gate could be reading a schema that waves every label through, which is the
    // one state indistinguishable from the write paths being open.
    const bogus = modelUpsertSchema.safeParse({
      ...WRITE_PATH_PROBE,
      allowCommercialUse: ['Sell', '__NotACommercialUse'],
    });

    expect(bogus.success).toBe(false);
  });
});
