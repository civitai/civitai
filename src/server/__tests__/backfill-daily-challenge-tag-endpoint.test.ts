import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ConcurrencyHelpers from '~/server/utils/concurrency-helpers';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';

/**
 * The fake stands in for the endpoint's SQL: it applies the cursor, ordering and LIMIT itself from
 * the positional params, so a wrong cursor shows up as a wrong set of written image ids. It cannot
 * see the SQL text, so column names, the ORDER BY and the scope filters are not tested here. Every
 * loop it drives terminates on its own: pages run out.
 */

const TAG_ID = 676575;
const MB = 1024 ** 2;

type Item = { id: number; imageId: number; tagged: boolean };
// One entry per slot read. A missing key is a slot with no row; null is a row whose restart_lsn is
// NULL, which is what an invalidated slot looks like.
type SlotRead = Record<string, number | null>;

const { state, events, tagRows, query, insertTagsOnImageNew, queueImageSearchIndexUpdate, sleep } =
  vi.hoisted(() => {
    const events: string[] = [];
    const state = {
      collections: new Map<number, Item[]>(),
      lags: [] as SlotRead[],
      lagReads: 0,
      // A fake WAL position that each written row advances by 1 MB; the LSN "text" is its number.
      wal: 0,
      walQueryFails: false,
      slotReadThrowsAt: -1,
    };
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('pg_replication_slots')) {
        events.push('slot-read');
        if (state.slotReadThrowsAt === state.lagReads) throw new Error('slot read failed');
        const read = state.lags[Math.min(state.lagReads++, state.lags.length - 1)];
        const [slots] = params as [string[]];
        return {
          rows: slots
            .filter((slot) => slot in read)
            .map((slot) => ({ slot, lag: read[slot] === null ? null : String(read[slot]) })),
        };
      }
      if (sql.includes('pg_current_wal_lsn()::text')) return { rows: [{ lsn: String(state.wal) }] };
      if (sql.includes('$1::pg_lsn')) {
        if (state.walQueryFails) throw new Error('wal read failed');
        return { rows: [{ bytes: String(state.wal - Number((params as string[])[0])) }] };
      }
      if (sql.includes('FROM "Challenge"')) {
        const [, from] = params as number[];
        return {
          rows: [...state.collections.keys()]
            .filter((id) => id >= from)
            .sort((a, b) => a - b)
            .map((id) => ({ id })),
        };
      }
      if (sql.includes('FROM "CollectionItem"')) {
        const [, collectionId, after, limit] = params as number[];
        return {
          rows: (state.collections.get(collectionId) ?? [])
            .filter((item) => item.id > after)
            .sort((a, b) => a.id - b.id)
            .slice(0, limit)
            .map((item) => ({ ...item })),
        };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    });
    const tagRows = async (rows: { imageId: number }[]) => {
      events.push('write');
      state.wal += rows.length * 1024 ** 2;
      for (const items of state.collections.values())
        for (const item of items)
          if (rows.some((r) => r.imageId === item.imageId)) item.tagged = true;
    };
    const insertTagsOnImageNew = vi.fn(tagRows);
    const sleep = vi.fn(async () => {
      events.push('sleep');
    });
    return {
      state,
      events,
      tagRows,
      query,
      insertTagsOnImageNew,
      queueImageSearchIndexUpdate: vi.fn(async () => undefined),
      sleep,
    };
  });

vi.mock('~/server/db/pgDb', () => ({ pgDbRead: {}, pgDbReadLong: {}, pgDbWrite: { query } }));
vi.mock('~/server/services/tagsOnImageNew.service', () => ({ insertTagsOnImageNew }));
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate }));
vi.mock('~/server/utils/concurrency-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof ConcurrencyHelpers>()),
  sleep,
}));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: null }));

const handler = (await import('~/pages/api/admin/temp/backfill-daily-challenge-tag')).default;

function call(query: Record<string, string>, token = 'test-webhook-token') {
  const req = { method: 'POST', query: { token, ...query }, headers: {} } as never;
  let statusCode = 0;
  let payload: Record<string, unknown> | undefined;
  const res = {
    on: () => res,
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

const writtenImageIds = () =>
  insertTagsOnImageNew.mock.calls.flatMap(([rows]) => rows.map((r) => r.imageId));

// The default slot, carrying the lag under test.
const lags = (...mbs: number[]): SlotRead[] => mbs.map((mb) => ({ mediarank_sub: mb * MB }));

// Collection 20's item ids sit BELOW collection 10's, as they do when two challenges' submission
// windows overlap, so a cursor carried from one collection into the next skips entries.
function seed() {
  state.collections = new Map([
    [
      10,
      [
        { id: 6, imageId: 101, tagged: false },
        { id: 7, imageId: 102, tagged: true },
        { id: 8, imageId: 103, tagged: false },
      ],
    ],
    [
      20,
      [
        { id: 4, imageId: 201, tagged: false },
        { id: 5, imageId: 202, tagged: false },
      ],
    ],
  ]);
}

describe('backfill-daily-challenge-tag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // reset, not clear: a leaked mockRejectedValueOnce would fail the NEXT test instead.
    insertTagsOnImageNew.mockReset();
    insertTagsOnImageNew.mockImplementation(tagRows);
    events.length = 0;
    state.wal = 0;
    state.walQueryFails = false;
    state.slotReadThrowsAt = -1;
    seed();
    state.lags = lags(10);
    state.lagReads = 0;
  });

  it('rejects a call with the wrong token, and reads nothing', async () => {
    const { statusCode } = await call({ dryRun: 'false' }, 'wrong');

    expect(statusCode).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('writes nothing unless dryRun=false is passed, and counts what it would tag', async () => {
    const { payload } = await call({ batchSize: '2' });

    expect(insertTagsOnImageNew).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ dryRun: true, done: true, untaggedFound: 4, written: 0 });
  });

  it('tags every untagged entry across collections with the challenge tag, skipping tagged ones', async () => {
    const { payload } = await call({ dryRun: 'false', batchSize: '2' });

    expect(insertTagsOnImageNew.mock.calls.flatMap(([rows]) => rows)).toEqual(
      [101, 103, 201, 202].map((imageId) => ({
        imageId,
        tagId: TAG_ID,
        source: 'User',
        confidence: 100,
        automated: true,
      }))
    );
    expect(payload).toMatchObject({
      done: true,
      written: 4,
      walMb: 4,
      requeueFailed: false,
      next: { collectionId: 20, itemId: 5 },
    });
    expect(queueImageSearchIndexUpdate).not.toHaveBeenCalled();
    // Logged as well as returned, so a proxy timeout on a long call cannot lose the cursor.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ written: 4, next: { collectionId: 20, itemId: 5 } })
    );
  });

  it('pauses, then re-reads the slots, before every write after the first', async () => {
    // Collection 10 ends on a short page (item 8). A pause placed only between full pages of one
    // collection would let collection 20's first write follow it immediately, and a pause placed
    // after the slot read would check lag before the subscriber had the pause to drain.
    await call({ dryRun: 'false', batchSize: '2', pauseMs: '500' });

    expect(sleep.mock.calls.every(([ms]) => ms === 500)).toBe(true);
    const writes = events.flatMap((event, i) => (event === 'write' ? [i] : []));
    expect(writes).toHaveLength(3);
    for (const i of writes.slice(1)) expect(events.slice(i - 2, i)).toEqual(['sleep', 'slot-read']);
  });

  it('stops before its first write when a slot has no row', async () => {
    state.lags = [{}];

    const { payload } = await call({ dryRun: 'false' });

    expect(insertTagsOnImageNew).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ done: false, stopReason: 'slot-not-found', written: 0 });
  });

  it('stops before its first write when a slot has a row but no retained WAL (invalidated)', async () => {
    state.lags = [{ mediarank_sub: null }];

    const { payload } = await call({ dryRun: 'false' });

    expect(insertTagsOnImageNew).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ stopReason: 'slot-not-found' });
  });

  it('checks every listed slot, and stops if any one of them is over the cap or missing', async () => {
    // The offending slot is listed first, so checking only the last slot would miss it.
    state.lags = [{ other: 2048 * MB, mediarank_sub: 10 * MB }];
    const worst = await call({ dryRun: 'false', slots: 'other,mediarank_sub' });

    expect(worst.payload).toMatchObject({
      stopReason: 'lag-over-max',
      stopSlot: 'other',
      lagMb: { other: 2048, mediarank_sub: 10 },
      // Recorded for every slot, including those after the one that stopped the loop.
      baselines: 'other:2048,mediarank_sub:10',
    });

    state.lags = [{ mediarank_sub: 10 * MB }];
    state.lagReads = 0;
    const missing = await call({ dryRun: 'false', slots: 'other,mediarank_sub' });

    expect(missing.payload).toMatchObject({ stopReason: 'slot-not-found' });
    expect(insertTagsOnImageNew).not.toHaveBeenCalled();
  });

  it('measures growth per slot, so a slot already holding a lot of WAL cannot hide growth on another', async () => {
    // Across both slots the maximum stays at 600 MB throughout, so growth on the maximum is zero.
    state.lags = [
      { other: 600 * MB, mediarank_sub: 10 * MB },
      { other: 600 * MB, mediarank_sub: 100 * MB },
    ];

    const { payload } = await call({
      dryRun: 'false',
      batchSize: '2',
      slots: 'other,mediarank_sub',
      maxLagGrowthMb: '64',
    });

    expect(payload).toMatchObject({
      stopReason: 'lag-grew',
      stopSlot: 'mediarank_sub',
      written: 1,
    });
  });

  it('stops when lag crosses maxLagMb mid-run, after the writes before it', async () => {
    state.lags = lags(10, 10, 2048);

    const { payload } = await call({
      dryRun: 'false',
      batchSize: '2',
      maxLagMb: '1024',
      maxLagGrowthMb: '1024',
    });

    expect(payload).toMatchObject({ stopReason: 'lag-over-max', written: 2 });
    expect(insertTagsOnImageNew).toHaveBeenCalledTimes(2);
  });

  it('measures growth from the start of the call, so a slow creep still stops it', async () => {
    // 40 MB a batch never exceeds 64 MB step to step; 80 MB since the start does.
    state.lags = lags(100, 140, 180);

    const { payload } = await call({ dryRun: 'false', batchSize: '2', maxLagGrowthMb: '64' });

    expect(payload).toMatchObject({
      stopReason: 'lag-grew',
      written: 2,
      baselines: 'mediarank_sub:100',
    });
  });

  it('keeps lowering the baseline mid-run, so growth is measured from the lowest lag seen', async () => {
    state.lags = lags(100, 30, 100);

    const { payload } = await call({ dryRun: 'false', batchSize: '2', maxLagGrowthMb: '64' });

    expect(payload).toMatchObject({
      stopReason: 'lag-grew',
      written: 2,
      baselines: 'mediarank_sub:30',
    });
  });

  it('measures growth from passed baselines, so resumed calls cannot creep past them', async () => {
    state.lags = lags(150);

    const { payload } = await call({
      dryRun: 'false',
      baselines: 'mediarank_sub:80',
      maxLagGrowthMb: '64',
    });

    expect(payload).toMatchObject({
      stopReason: 'lag-grew',
      baselines: 'mediarank_sub:80',
      written: 0,
    });
    expect(insertTagsOnImageNew).not.toHaveBeenCalled();
  });

  it('resumes from the cursor it returns after a lag stop', async () => {
    state.lags = lags(100, 100, 200);

    const first = await call({ dryRun: 'false', batchSize: '2', maxLagGrowthMb: '64' });

    expect(first.payload).toMatchObject({
      stopReason: 'lag-grew',
      written: 2,
      next: { collectionId: 20, itemId: 0 },
    });
    expect(writtenImageIds().sort()).toEqual([101, 103]);

    state.lags = lags(100);
    state.lagReads = 0;
    insertTagsOnImageNew.mockClear();
    const next = first.payload.next as { collectionId: number; itemId: number };

    const second = await call({
      dryRun: 'false',
      batchSize: '2',
      collectionId: String(next.collectionId),
      itemId: String(next.itemId),
    });

    expect(second.payload).toMatchObject({ done: true, written: 2 });
    expect(writtenImageIds().sort()).toEqual([201, 202]);
    // The stopped call logged its cursor too, not only the finished one.
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ stopReason: 'lag-grew', next: { collectionId: 20, itemId: 0 } })
    );
  });

  it('round-trips baselines for several slots, so each slot resumes from its own floor', async () => {
    state.lags = [{ other: 600 * MB, mediarank_sub: 10 * MB }];
    const first = await call({
      dryRun: 'false',
      batchSize: '1',
      maxBatches: '1',
      slots: 'other,mediarank_sub',
    });

    expect(first.payload).toMatchObject({ baselines: 'other:600,mediarank_sub:10' });

    state.lags = [{ other: 600 * MB, mediarank_sub: 100 * MB }];
    state.lagReads = 0;
    const second = await call({
      dryRun: 'false',
      slots: 'other,mediarank_sub',
      baselines: String(first.payload.baselines),
      maxLagGrowthMb: '64',
    });

    expect(second.payload).toMatchObject({ stopReason: 'lag-grew', stopSlot: 'mediarank_sub' });
  });

  it('floors the returned baselines, so passing them back can only tighten the guard', async () => {
    state.lags = [{ mediarank_sub: 100 * MB + MB / 2 + 1 }];

    const { payload } = await call({ dryRun: 'false', maxBatches: '1' });

    expect(payload).toMatchObject({ baselines: 'mediarank_sub:100' });
  });

  it('stops growth at the 256 MB default when no threshold is passed', async () => {
    state.lags = lags(0, 300);
    const grew = await call({ dryRun: 'false', batchSize: '2' });

    expect(grew.payload).toMatchObject({ stopReason: 'lag-grew', written: 1 });

    state.lags = lags(0, 200);
    state.lagReads = 0;
    seed();
    const held = await call({ dryRun: 'false', batchSize: '2' });

    expect(held.payload).toMatchObject({ done: true });
  });

  it('still returns the cursor when a slot read throws after earlier writes committed', async () => {
    state.slotReadThrowsAt = 1;

    const { statusCode, payload } = await call({ dryRun: 'false', batchSize: '2' });

    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({
      stopReason: 'error',
      written: 1,
      next: { collectionId: 10, itemId: 7 },
    });
    expect(JSON.stringify(payload)).not.toContain('slot read failed');
  });

  it.each([
    ['the error log', true],
    ['the summary log', false],
  ])('still returns the cursor when %s is rejected', async (_, failWrite) => {
    loggingMock.logToAxiom.mockImplementation(() => Promise.reject(new Error('axiom down')));
    if (failWrite) insertTagsOnImageNew.mockRejectedValueOnce(new Error('boom'));

    const { statusCode, payload } = await call({ dryRun: 'false', batchSize: '2' }).finally(() =>
      // The shared mock outlives this test, and clearAllMocks keeps implementations.
      loggingMock.logToAxiom.mockImplementation(() => Promise.resolve(undefined))
    );

    expect(loggingMock.logToAxiom).toHaveBeenCalledTimes(failWrite ? 2 : 1);
    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({
      next: failWrite ? { collectionId: 10, itemId: 0 } : { collectionId: 20, itemId: 5 },
    });
  });

  it('omits baselines when none were read, and accepts an empty one passed back', async () => {
    state.lags = [{}];
    const first = await call({ dryRun: 'false' });

    expect(first.payload.baselines).toBeUndefined();

    state.lags = lags(10);
    state.lagReads = 0;
    const second = await call({ dryRun: 'false', baselines: '' });

    // An empty entry must not survive as ":NaN", which the next resume would refuse.
    expect(second.payload).toMatchObject({ done: true, written: 4, baselines: 'mediarank_sub:10' });
  });

  it('returns the last committed cursor when a write fails, and queues that batch for the index', async () => {
    insertTagsOnImageNew.mockRejectedValueOnce(new Error('boom'));

    const { payload } = await call({ dryRun: 'false', batchSize: '2' });

    expect(payload).toMatchObject({
      stopReason: 'error',
      requeueFailed: false,
      written: 0,
      next: { collectionId: 10, itemId: 0 },
    });
    // Driver text can carry row values, so it goes to the log and never into the body.
    expect(JSON.stringify(payload)).not.toContain('boom');
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'boom' })
    );
    expect(queueImageSearchIndexUpdate).toHaveBeenCalledTimes(1);
    expect(queueImageSearchIndexUpdate).toHaveBeenCalledWith({ ids: [101], action: 'Update' });
  });

  it('still returns the cursor when the index requeue after a failed write also fails', async () => {
    insertTagsOnImageNew.mockRejectedValueOnce(new Error('boom'));
    queueImageSearchIndexUpdate.mockRejectedValueOnce(new Error('queue down'));

    const { statusCode, payload } = await call({ dryRun: 'false', batchSize: '2' });

    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({
      stopReason: 'error',
      requeueFailed: true,
      next: { collectionId: 10, itemId: 0 },
    });
  });

  it('still returns the cursor when the closing WAL read fails after writes committed', async () => {
    state.walQueryFails = true;

    const { statusCode, payload } = await call({ dryRun: 'false', batchSize: '2' });

    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({
      done: true,
      written: 4,
      walMb: null,
      next: { collectionId: 20, itemId: 5 },
    });
  });

  it.each([
    ['a slot list with an empty entry', { slots: 'mediarank_sub,' }],
    ['a baseline without a number', { baselines: 'mediarank_sub' }],
    // Unanchored, "80x" would pass and parse to NaN, which switches the growth check off.
    ['a baseline with trailing junk', { baselines: 'mediarank_sub:80x' }],
  ])('refuses %s before reading or writing anything', async (_, params) => {
    await call({ dryRun: 'false', ...params }).catch(() => undefined);

    expect(query).not.toHaveBeenCalled();
    expect(insertTagsOnImageNew).not.toHaveBeenCalled();
  });

  it('treats a baseline of 0 as a baseline, passed or measured', async () => {
    state.lags = lags(70);
    const passed = await call({
      dryRun: 'false',
      baselines: 'mediarank_sub:0',
      maxLagGrowthMb: '64',
    });

    expect(passed.payload).toMatchObject({ stopReason: 'lag-grew', written: 0 });

    state.lags = lags(0, 70);
    state.lagReads = 0;
    const measured = await call({ dryRun: 'false', batchSize: '2', maxLagGrowthMb: '64' });

    expect(measured.payload).toMatchObject({
      stopReason: 'lag-grew',
      baselines: 'mediarank_sub:0',
      written: 1,
    });
  });

  it('lowers passed baselines to the lag actually seen, so an inflated one cannot loosen the guard', async () => {
    state.lags = lags(100, 180);

    const { payload } = await call({
      dryRun: 'false',
      batchSize: '2',
      baselines: 'mediarank_sub:500',
      maxLagGrowthMb: '64',
    });

    expect(payload).toMatchObject({
      stopReason: 'lag-grew',
      baselines: 'mediarank_sub:100',
      written: 1,
    });
  });

  it('carries the returned baselines into the next call, so growth across calls still stops it', async () => {
    state.lags = lags(100, 140);
    const first = await call({
      dryRun: 'false',
      batchSize: '2',
      maxBatches: '2',
      maxLagGrowthMb: '64',
    });

    expect(first.payload).toMatchObject({
      stopReason: 'max-batches',
      baselines: 'mediarank_sub:100',
    });

    state.lags = lags(180);
    state.lagReads = 0;
    const next = first.payload.next as { collectionId: number; itemId: number };
    const second = await call({
      dryRun: 'false',
      batchSize: '2',
      collectionId: String(next.collectionId),
      itemId: String(next.itemId),
      baselines: String(first.payload.baselines),
      maxLagGrowthMb: '64',
    });

    expect(second.payload).toMatchObject({ stopReason: 'lag-grew', written: 0 });
  });

  it('stops at maxBatches mid-collection, and a resume from there still covers later collections', async () => {
    const first = await call({ dryRun: 'false', batchSize: '1', maxBatches: '2' });

    expect(first.payload).toMatchObject({
      stopReason: 'max-batches',
      batches: 2,
      next: { collectionId: 10, itemId: 7 },
    });
    expect(writtenImageIds()).toEqual([101]);

    insertTagsOnImageNew.mockClear();
    const second = await call({ dryRun: 'false', batchSize: '1', collectionId: '10', itemId: '7' });

    expect(second.payload).toMatchObject({ done: true, written: 3 });
    expect(writtenImageIds()).toEqual([103, 201, 202]);
  });
});
