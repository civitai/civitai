import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ConcurrencyHelpers from '~/server/utils/concurrency-helpers';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/db.mock';

/**
 * The fake answers the endpoint's three queries from an in-memory table and honours the cursor,
 * ORDER BY and LIMIT, so a wrong cursor shows up as a wrong set of written image ids rather than
 * as a passing call count. Every loop it drives terminates on its own: pages run out.
 */

const TAG_ID = 676575;
const MB = 1024 ** 2;

type Item = { id: number; imageId: number; tagged: boolean };

const { state, query, insertTagsOnImageNew, sleep } = vi.hoisted(() => {
  const state = {
    collections: new Map<number, Item[]>(),
    lags: [] as (number | null)[],
    lagReads: 0,
  };
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('pg_replication_slots')) {
      const lag = state.lags[Math.min(state.lagReads++, state.lags.length - 1)];
      return { rows: lag === null ? [] : [{ lag: String(lag) }] };
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
  const insertTagsOnImageNew = vi.fn(async (rows: { imageId: number }[]) => {
    for (const items of state.collections.values())
      for (const item of items)
        if (rows.some((r) => r.imageId === item.imageId)) item.tagged = true;
  });
  return { state, query, insertTagsOnImageNew, sleep: vi.fn(async () => undefined) };
});

vi.mock('~/server/db/pgDb', async () => {
  const { createPgDbMock } = await import('~/test-utils/pgDbMock');
  return createPgDbMock({ pgDbWrite: { query } });
});
vi.mock('~/server/services/tagsOnImageNew.service', () => ({ insertTagsOnImageNew }));
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
    seed();
    state.lags = [10 * MB];
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

    expect(writtenImageIds().sort()).toEqual([101, 103, 201, 202]);
    expect(insertTagsOnImageNew.mock.calls.flatMap(([rows]) => rows)).toEqual(
      [101, 103, 201, 202].map((imageId) =>
        expect.objectContaining({ imageId, tagId: TAG_ID, automated: true })
      )
    );
    expect(payload).toMatchObject({
      done: true,
      written: 4,
      next: { collectionId: 20, itemId: 5 },
    });
  });

  it('pauses after every written batch, including one that ends a collection', async () => {
    // Collection 10 ends on a short page (item 8). A pause placed only between full pages of one
    // collection sleeps twice here, letting collection 20's first write follow it immediately.
    await call({ dryRun: 'false', batchSize: '2', pauseMs: '500' });

    expect(insertTagsOnImageNew).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [500], [500]]);
  });

  it('stops before its first write when the replication slot cannot be read', async () => {
    state.lags = [null];

    const { payload } = await call({ dryRun: 'false' });

    expect(insertTagsOnImageNew).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ done: false, stopReason: 'slot-not-found', written: 0 });
  });

  it('stops before its first write when the slot is already over maxLagMb', async () => {
    state.lags = [2048 * MB];

    const { payload } = await call({ dryRun: 'false', maxLagMb: '1024' });

    expect(insertTagsOnImageNew).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ stopReason: 'lag-over-max', lagMb: 2048 });
  });

  it('stops when lag grows past maxLagGrowthMb, and resumes from the cursor it returns', async () => {
    state.lags = [100 * MB, 100 * MB, 200 * MB];

    const first = await call({ dryRun: 'false', batchSize: '2', maxLagGrowthMb: '64' });

    expect(first.payload).toMatchObject({
      stopReason: 'lag-grew',
      written: 2,
      lagGrowthMb: 100,
      next: { collectionId: 20, itemId: 0 },
    });
    expect(writtenImageIds().sort()).toEqual([101, 103]);

    state.lags = [100 * MB];
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

  it('returns the last committed cursor when a write fails, so a rerun repeats that batch', async () => {
    insertTagsOnImageNew.mockRejectedValueOnce(new Error('boom'));

    const { payload } = await call({ dryRun: 'false', batchSize: '2' });

    expect(payload).toMatchObject({
      stopReason: 'error',
      error: 'boom',
      written: 0,
      next: { collectionId: 10, itemId: 0 },
    });
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
