import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A storage delete that fails after its Image row is gone leaves a publicly served object whose
 * key exists nowhere but this queue. The properties pinned here:
 *
 *   1. the job is a quiet no-op until the enum label exists, because the code ships first;
 *   2. it reads, and removes, ONLY its own queue type — JobQueue is keyed by image id across
 *      types, so a dropped type filter would delete another queue's row for the same image
 *      (`BlockedImageDelete` is the take-down queue);
 *   3. a key that deletes, or is legitimately skipped, leaves the queue — so does a row whose
 *      payload carries no usable key, which is logged; one that fails again
 *      stays, with its original `createdAt`, so the overdue check can see it age;
 *   4. one key throwing does not cost the rest of the run its dequeue;
 *   5. no new batch starts past the run budget, so a slow outage cannot outlive the lock;
 *   6. a non-prod environment never deletes production media.
 */

const { mockDeleteImageFromS3, mockOther } = vi.hoisted(() => ({
  mockDeleteImageFromS3: vi.fn(),
  mockOther: { isProd: true },
}));

// Hand-listed rather than spread from the real module: image.service is ~8k lines and builds
// module-scope caches on import.
vi.mock('~/server/services/image.service', () => ({ deleteImageFromS3: mockDeleteImageFromS3 }));
vi.mock('~/env/other', () => ({
  get isProd() {
    return mockOther.isProd;
  },
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import {
  RETRY_BATCH_SIZE,
  RUN_BUDGET_MS,
  retryImageStorageDeletes,
} from '~/server/jobs/retry-image-storage-deletes';

const DELETES_ID = 11;
const SHARED_ID = 12;
const STILL_FAILING_ID = 13;
const NULL_DATA_ID = 14;
const EMPTY_URL_ID = 16;
const THROWS_ID = 15;

const QUEUE = [
  { id: DELETES_ID, data: { url: 'key-deletes' } },
  { id: SHARED_ID, data: { url: 'key-shared' } },
  { id: STILL_FAILING_ID, data: { url: 'key-failing' } },
  { id: NULL_DATA_ID, data: null },
  { id: THROWS_ID, data: { url: 'key-throws' } },
  { id: EMPTY_URL_ID, data: { url: '' } },
];

const OUTCOMES: Record<string, 'deleted' | 'skipped' | 'failed'> = {
  'key-deletes': 'deleted',
  'key-shared': 'skipped',
  'key-failing': 'failed',
};

const mockLogToAxiom = loggingMock.logToAxiom;

const ctx = {} as Parameters<typeof retryImageStorageDeletes.run>[0];
const runJob = () => retryImageStorageDeletes.run(ctx).result as Promise<Record<string, unknown>>;

type Call = { sql: string; values: unknown[] };
const toCall = (call: unknown[]): Call => ({
  sql: (call[0] as TemplateStringsArray).join('?'),
  values: call.slice(1),
});
const reads = () => dbMock.dbWrite.$queryRaw.mock.calls.map(toCall);
const writes = () => dbMock.dbWrite.$executeRaw.mock.calls.map(toCall);

let probe: { ready: boolean }[] = [{ ready: true }];
let queue: { id: number; data: unknown }[] = QUEUE;

beforeEach(() => {
  vi.clearAllMocks();
  setEnv({ DATABASE_IS_PROD: true });
  mockOther.isProd = true;
  probe = [{ ready: true }];
  queue = QUEUE;
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('pg_enum')) return probe;
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

describe('retry-image-storage-deletes', () => {
  it('probes for its own enum label and the data column', async () => {
    await runJob();

    const [probeCall] = reads();
    expect(probeCall.values).toEqual(['ImageStorageDelete']);
    expect(probeCall.sql).toContain("t.typname = 'JobQueueType'");
    expect(probeCall.sql).toContain("table_name = 'JobQueue' AND column_name = 'data'");
    // Both must exist: the two halves are separate migrations and can land apart.
    expect(probeCall.sql).toMatch(/\)\s+AND EXISTS \(/);
  });

  it.each([
    ['the label or column is missing', [{ ready: false }]],
    ['the probe returns no row', []],
  ])('does nothing when %s', async (_, result) => {
    probe = result;

    expect(await runJob()).toEqual({ ready: false });
    expect(reads()).toHaveLength(1);
    expect(mockDeleteImageFromS3).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });

  it('reads only its own queue type, oldest first, one batch', async () => {
    await runJob();

    const select = reads()[1];
    expect(select.values).toEqual(['ImageStorageDelete', 'Image', RETRY_BATCH_SIZE]);
    // The column the probe checks must be the one read, under the names the row handler uses.
    expect(select.sql).toMatch(/SELECT "entityId" AS id, data\s+FROM "JobQueue"/);
    expect(select.sql).toMatch(
      /WHERE type = \?::"JobQueueType"\s+AND "entityType" = \?::"EntityType"/
    );
    expect(select.sql).toMatch(/ORDER BY "createdAt" ASC\s+LIMIT \?/);
  });

  it('retries every queued key with the purge suppressed and a deadline before the lock', async () => {
    await runJob();

    // 20-minute lock less a 2-minute margin.
    expect(timeoutSpy).toHaveBeenCalledWith(18 * 60 * 1000);
    const deadline = timeoutSpy.mock.results[0].value;
    expect(mockDeleteImageFromS3.mock.calls.map((c) => c[0])).toEqual(
      [
        [DELETES_ID, 'key-deletes'],
        [SHARED_ID, 'key-shared'],
        [STILL_FAILING_ID, 'key-failing'],
        [THROWS_ID, 'key-throws'],
      ].map(([id, url]) => ({ id, url, purgeOnFailure: false, abortSignal: deadline }))
    );
  });

  it('dequeues deleted, skipped and malformed rows of its own type only', async () => {
    const result = await runJob();

    expect(writes()).toHaveLength(1);
    const [dequeue] = writes();
    expect(dequeue.sql).toMatch(
      /DELETE FROM "JobQueue"\s+WHERE type = \?::"JobQueueType"\s+AND "entityType" = \?::"EntityType"\s+AND "entityId" = ANY\(\?::integer\[\]\)/
    );
    expect(dequeue.values[0]).toBe('ImageStorageDelete');
    expect(dequeue.values[1]).toBe('Image');
    expect((dequeue.values[2] as number[]).slice().sort()).toEqual([
      DELETES_ID,
      SHARED_ID,
      NULL_DATA_ID,
      EMPTY_URL_ID,
    ]);
    expect(result).toEqual({ deleted: 1, skipped: 1, failed: 2, malformed: 2, unattempted: 0 });
    const warnings = mockLogToAxiom.mock.calls
      .map(([event]) => event as Record<string, unknown>)
      .filter((event) => event.type === 'warning');
    expect(warnings).toEqual([
      expect.objectContaining({
        name: 'retry-image-storage-deletes',
        imageIds: [NULL_DATA_ID, EMPTY_URL_ID],
      }),
    ]);
  });

  // The job issues no write against a failed row. The service's re-enqueue is the other writer;
  // its upsert is pinned in delete-image-from-s3-logging.test.ts.
  it('leaves rows that failed, or threw, queued and untouched', async () => {
    await runJob();

    const touched = writes().flatMap((w) => w.values.filter(Array.isArray).flat());
    expect(touched).not.toContain(STILL_FAILING_ID);
    expect(touched).not.toContain(THROWS_ID);
    expect(writes().some((w) => w.sql.includes('UPDATE'))).toBe(false);
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
    expect(writes()[0].values[2]).toEqual([100, 101, 102, 103, 104]);
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

  it.each([
    ['DATABASE_IS_PROD is off', () => setEnv({ DATABASE_IS_PROD: false })],
    ['the app is not prod', () => (mockOther.isProd = false)],
  ])('never deletes when %s', async (_, arrange) => {
    arrange();

    expect(await runJob()).toEqual({ wouldRetry: QUEUE.length });
    expect(mockDeleteImageFromS3).not.toHaveBeenCalled();
    expect(writes()).toHaveLength(0);
  });
});
