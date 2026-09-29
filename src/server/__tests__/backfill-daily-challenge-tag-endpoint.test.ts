import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ConcurrencyHelpers from '~/server/utils/concurrency-helpers';
import '~/__tests__/mocks/logging.mock';
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
    };
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('pg_replication_slots')) {
        events.push('slot-read');
        const read = state.lags[Math.min(state.lagReads++, state.lags.length - 1)];
        const [slots] = params as [string[]];
        return {
          rows: slots
            .filter((slot) => slot in read)
            .map((slot) => ({ slot, lag: read[slot] === null ? null : String(read[slot]) })),
        };
      }
      if (sql.includes('pg_current_wal_lsn()::text')) return { rows: [{ lsn: '0/0' }] };
      if (sql.includes('$1::pg_lsn')) return { rows: [{ bytes: String(5 * MB) }] };
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

vi.mock('~/server/db/pgDb', async () => {
  const { createPgDbMock } = await import('~/test-utils/pgDbMock');
  return createPgDbMock({ pgDbWrite: { query } });
});
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
      walMb: 5,
      next: { collectionId: 20, itemId: 5 },
    });
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

  it('guards on the worst of several slots, and stops if any one of them is missing', async () => {
    state.lags = [{ mediarank_sub: 10 * MB, debezium: 2048 * MB }];
    const worst = await call({ dryRun: 'false', slots: 'mediarank_sub,debezium' });

    expect(worst.payload).toMatchObject({ stopReason: 'lag-over-max', lagMb: 2048 });

    state.lags = [{ mediarank_sub: 10 * MB }];
    state.lagReads = 0;
    const missing = await call({ dryRun: 'false', slots: 'mediarank_sub,debezium' });

    expect(missing.payload).toMatchObject({ stopReason: 'slot-not-found' });
    expect(insertTagsOnImageNew).not.toHaveBeenCalled();
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

    expect(payload).toMatchObject({ stopReason: 'lag-grew', written: 2, baselineMb: 100 });
  });

  it('measures growth from a passed baselineMb, so resumed calls cannot creep past it', async () => {
    state.lags = lags(150);

    const { payload } = await call({ dryRun: 'false', baselineMb: '80', maxLagGrowthMb: '64' });

    expect(payload).toMatchObject({ stopReason: 'lag-grew', baselineMb: 80, written: 0 });
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
  });

  it('returns the last committed cursor when a write fails, and queues that batch for the index', async () => {
    insertTagsOnImageNew.mockRejectedValueOnce(new Error('boom'));

    const { payload } = await call({ dryRun: 'false', batchSize: '2' });

    expect(payload).toMatchObject({
      stopReason: 'error',
      error: 'boom',
      written: 0,
      next: { collectionId: 10, itemId: 0 },
    });
    expect(queueImageSearchIndexUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ ids: [101] })
    );
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
