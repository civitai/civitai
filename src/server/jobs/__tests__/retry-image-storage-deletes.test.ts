import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A storage delete that fails after its Image row is gone leaves a publicly served object whose
 * key exists nowhere but this queue. The properties pinned here:
 *
 *   1. the job is a quiet no-op until the migration adds the enum label and column, because the
 *      code ships first and the migration follows the deploy;
 *   2. a key that deletes, or that is legitimately skipped, leaves the queue;
 *   3. a key that fails again STAYS, and moves to the back so it cannot starve the rest;
 *   4. a non-prod database never deletes production media.
 */

const { mockDeleteImageFromS3, mockEnv } = vi.hoisted(() => ({
  mockDeleteImageFromS3: vi.fn(),
  mockEnv: { DATABASE_IS_PROD: true },
}));

// Hand-listed rather than spread from the real module: image.service is ~8k lines and builds
// module-scope caches on import.
vi.mock('~/server/services/image.service', () => ({ deleteImageFromS3: mockDeleteImageFromS3 }));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({ env: mockEnv }));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { retryImageStorageDeletes } from '~/server/jobs/retry-image-storage-deletes';

const DELETES_ID = 11;
const SHARED_ID = 12;
const STILL_FAILING_ID = 13;
const NO_URL_ID = 14;

const QUEUE = [
  { id: DELETES_ID, url: 'key-deletes' },
  { id: SHARED_ID, url: 'key-shared' },
  { id: STILL_FAILING_ID, url: 'key-failing' },
  { id: NO_URL_ID, url: null },
];

const OUTCOMES: Record<string, 'deleted' | 'skipped' | 'failed'> = {
  'key-deletes': 'deleted',
  'key-shared': 'skipped',
  'key-failing': 'failed',
};

const ctx = {} as Parameters<typeof retryImageStorageDeletes.run>[0];
const runJob = () => retryImageStorageDeletes.run(ctx).result as Promise<Record<string, unknown>>;

const writes = () =>
  dbMock.dbWrite.$executeRaw.mock.calls.map((call: unknown[]) => ({
    sql: (call[0] as TemplateStringsArray).join('?'),
    values: call.slice(1),
  }));
const idsOf = (needle: string) =>
  (writes()
    .find((w) => w.sql.includes(needle))
    ?.values.find(Array.isArray) as number[] | undefined) ?? [];

let ready = true;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.DATABASE_IS_PROD = true;
  ready = true;
  dbMock.dbWrite.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('pg_enum')) return [{ ready }];
    if (sql.includes('FROM "JobQueue"')) return QUEUE;
    throw new Error(`unexpected query: ${sql}`);
  });
  dbMock.dbWrite.$executeRaw.mockResolvedValue(0);
  mockDeleteImageFromS3.mockImplementation(async ({ url }: { url: string }) => OUTCOMES[url]);
});

describe('retry-image-storage-deletes', () => {
  it('does nothing before the migration exists', async () => {
    ready = false;

    const result = await runJob();

    expect(result).toEqual({ ready: false });
    expect(dbMock.dbWrite.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockDeleteImageFromS3).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('retries every queued key that has one', async () => {
    await runJob();

    expect(mockDeleteImageFromS3.mock.calls.map((c) => c[0])).toEqual([
      { id: DELETES_ID, url: 'key-deletes' },
      { id: SHARED_ID, url: 'key-shared' },
      { id: STILL_FAILING_ID, url: 'key-failing' },
    ]);
  });

  it('dequeues deleted, skipped and keyless rows, and keeps the one that failed again', async () => {
    const result = await runJob();

    expect(idsOf('DELETE FROM "JobQueue"').sort()).toEqual([DELETES_ID, SHARED_ID, NO_URL_ID]);
    expect(idsOf('UPDATE "JobQueue"')).toEqual([STILL_FAILING_ID]);
    expect(result).toEqual({ deleted: 1, skipped: 2, failed: 1 });
  });

  it('never deletes from a non-prod database', async () => {
    mockEnv.DATABASE_IS_PROD = false;

    const result = await runJob();

    expect(result).toEqual({ wouldRetry: QUEUE.length });
    expect(mockDeleteImageFromS3).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });
});
