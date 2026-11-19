import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every deleted image's stored file is queued with its delete, and its key exists nowhere but this
 * queue. The properties pinned here, and against real SQL in image-storage-deletes.pglite.test.ts:
 *
 *   1. it reads, and removes, ONLY its own queue type — JobQueue is keyed by image id across
 *      types, so a dropped type filter would delete another queue's row for the same image
 *      (`BlockedImageDelete` is the take-down queue);
 *   2. each key goes as it was queued (all versions, shop artwork kept), and only its first
 *      failure purges the resize cache;
 *   3. a key that deletes, or is legitimately skipped, leaves the queue — so does a row whose
 *      payload carries no usable key, which is logged; one that fails stays, with its original
 *      `createdAt`, so the overdue check can see it age, and is marked attempted;
 *   4. one key throwing does not cost the rest of the run its dequeue;
 *   5. no new batch starts past the run budget, so a slow outage cannot outlive the lock;
 *   6. a non-prod environment never deletes production media.
 */

const { mockDeleteImageFromS3, mockOther } = vi.hoisted(() => ({
  mockDeleteImageFromS3: vi.fn(),
  mockOther: { isProd: true },
}));

// Hand-listed rather than spread from the real module, which builds module-scope caches on import.
vi.mock('~/server/services/image.service', () => ({ deleteImageFromS3: mockDeleteImageFromS3 }));
vi.mock('~/env/other', () => ({
  get isProd() {
    return mockOther.isProd;
  },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { RUN_BUDGET_MS, imageStorageDeletes } from '~/server/jobs/image-storage-deletes';

const DELETES_ID = 11;
const SHARED_ID = 12;
const STILL_FAILING_ID = 13;
const NULL_DATA_ID = 14;
const EMPTY_URL_ID = 16;
const THROWS_ID = 15;

const QUEUE = [
  { id: DELETES_ID, data: { url: 'key-deletes' } },
  { id: SHARED_ID, data: { url: 'key-shared' } },
  { id: STILL_FAILING_ID, data: { url: 'key-failing', attempted: true } },
  { id: NULL_DATA_ID, data: null },
  { id: THROWS_ID, data: { url: 'key-throws' } },
  { id: EMPTY_URL_ID, data: { url: '' } },
];

const OUTCOMES: Record<string, 'deleted' | 'skipped' | 'failed'> = {
  'key-deletes': 'deleted',
  'key-shared': 'skipped',
  'key-failing': 'failed',
};

const ctx = {} as Parameters<typeof imageStorageDeletes.run>[0];
const runJob = () => imageStorageDeletes.run(ctx).result as Promise<Record<string, unknown>>;

type Call = { sql: string; values: unknown[] };
const toCall = (call: unknown[]): Call => ({
  sql: (call[0] as TemplateStringsArray).join('?'),
  values: call.slice(1),
});
const writes = () => dbMock.dbWrite.$executeRaw.mock.calls.map(toCall);
const dequeues = () => writes().filter((w) => w.sql.includes('DELETE FROM "JobQueue"'));
/** The id list a write was given, wherever it sits among the statement's values. */
const idsOf = (write: Call) => write.values.find(Array.isArray) as number[];

let queue: { id: number; data: unknown }[] = QUEUE;

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ DATABASE_IS_PROD: true });
  mockOther.isProd = true;
  queue = QUEUE;
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('FROM "JobQueue"')) return queue;
    throw new Error(`unexpected query: ${sql}`);
  });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
  mockDeleteImageFromS3.mockImplementation(async ({ url }: { url: string }) => {
    if (url === 'key-throws') throw new Error('purge exploded');
    return OUTCOMES[url];
  });
});

const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');

afterEach(() => {
  vi.useRealTimers();
});

describe('image-storage-deletes', () => {
  it('deletes every queued key, purging only on a first attempt, with a deadline before the lock', async () => {
    await runJob();

    // 20-minute lock less a 2-minute margin.
    expect(timeoutSpy).toHaveBeenCalledWith(18 * 60 * 1000);
    const deadline = timeoutSpy.mock.results[0].value;
    expect(mockDeleteImageFromS3.mock.calls.map((c) => c[0])).toEqual(
      (
        [
          [DELETES_ID, 'key-deletes', true],
          [SHARED_ID, 'key-shared', true],
          [STILL_FAILING_ID, 'key-failing', false],
          [THROWS_ID, 'key-throws', true],
        ] as const
      ).map(([id, url, purgeOnFailure]) =>
        expect.objectContaining({ id, url, purgeOnFailure, abortSignal: deadline })
      )
    );
  });

  it('deletes a key as it was queued', async () => {
    queue = [
      { id: DELETES_ID, data: { url: 'key-deletes', allVersions: true } },
      { id: SHARED_ID, data: { url: 'key-shared', keepShopArtwork: true } },
    ];
    await runJob();
    expect(mockDeleteImageFromS3.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ id: DELETES_ID, allVersions: true, keepShopArtwork: undefined }),
      expect.objectContaining({ id: SHARED_ID, allVersions: undefined, keepShopArtwork: true }),
    ]);
  });

  it('counts a key that throws as failed, and still finishes the run', async () => {
    expect(await runJob()).toEqual({
      deleted: 1,
      skipped: 1,
      failed: 2,
      malformed: 2,
      unattempted: 0,
    });
  });

  it('starts no new batch once the run budget is spent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    // Ten keys = two batches of five. The first batch eats the whole budget.
    queue = Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, data: { url: `key-${i}` } }));
    mockDeleteImageFromS3.mockImplementation(async () => {
      vi.setSystemTime(RUN_BUDGET_MS + 1);
      return 'deleted';
    });

    const result = await runJob();

    expect(mockDeleteImageFromS3).toHaveBeenCalledTimes(5);
    expect(result).toMatchObject({ deleted: 5, unattempted: 5 });
    expect(idsOf(dequeues()[0])).toEqual([100, 101, 102, 103, 104]);
  });

  it('still starts a batch with the budget exactly spent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    queue = Array.from({ length: 10 }, (_, i) => ({ id: 100 + i, data: { url: `key-${i}` } }));
    mockDeleteImageFromS3.mockImplementation(async () => {
      vi.setSystemTime(RUN_BUDGET_MS);
      return 'deleted';
    });

    expect(await runJob()).toMatchObject({ deleted: 10, unattempted: 0 });
    // One deadline for the whole run: a fresh one per batch would let a late batch outlive the lock.
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    const deadline = timeoutSpy.mock.results[0].value;
    for (const [call] of mockDeleteImageFromS3.mock.calls) expect(call.abortSignal).toBe(deadline);
  });

  it("leaves production's rows alone when a non-prod app reaches production's database", async () => {
    mockOther.isProd = false;

    expect(await runJob()).toEqual({ wouldDelete: QUEUE.length });
    expect(mockDeleteImageFromS3).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it('never deletes on a database that is not production, and drops its rows', async () => {
    setEnv({ DATABASE_IS_PROD: false });

    expect(await runJob()).toEqual({ dropped: QUEUE.length });
    expect(mockDeleteImageFromS3).not.toHaveBeenCalled();
    expect(dequeues()).toHaveLength(1);
    expect(idsOf(dequeues()[0])).toEqual(QUEUE.map((row) => row.id));
  });
});
