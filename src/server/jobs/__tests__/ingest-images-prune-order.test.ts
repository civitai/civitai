import { describe, it, expect, vi, beforeEach } from 'vitest';

// The stale-row prune must run BEFORE the scan-submission fan-out. Gating it behind
// the (slow, sometimes-failing) send loop is what let stale rows accumulate faster
// than they cleared and self-poison the queue. This drives the real job with a mix
// of stale (non-scannable) and eligible (Pending) rows and asserts the JobQueue
// DELETE happens before the first ingestImage call.

const {
  callLog,
  mockDbRead,
  mockDbWrite,
  mockIngestImage,
  mockDeleteImages,
  mockLimitConcurrency,
} = vi.hoisted(() => {
  const callLog: string[] = [];
  const pulled: { ids: number[] } = { ids: [] };
  return {
    callLog,
    mockDbRead: {
      jobQueue: {
        findMany: vi.fn(async ({ take }: { take: number }) => {
          pulled.ids = Array.from({ length: take }, (_, i) => i + 1);
          return pulled.ids.map((entityId) => ({ entityId }));
        }),
      },
    },
    mockDbWrite: {
      // Half the pulled ids come back Pending (eligible → submitted); the other
      // half come back already Scanned (terminal → stale, to be pruned).
      $queryRaw: vi.fn(async () =>
        pulled.ids.map((id) => ({
          id,
          url: `img-${id}`,
          type: 'image',
          width: 100,
          height: 100,
          prompt: null,
          scanRequestedAt: null,
          ingestion: id % 2 === 0 ? 'Scanned' : 'Pending',
          retryCount: 0,
          isBackfill: false,
        }))
      ),
      $executeRaw: vi.fn(async () => {
        callLog.push('delete');
        return 0;
      }),
    },
    mockIngestImage: vi.fn(async () => {
      callLog.push('ingest');
      return true;
    }),
    mockDeleteImages: vi.fn(async () => undefined),
    mockLimitConcurrency: vi.fn(async (tasks: Array<() => Promise<unknown>>) => {
      for (const t of tasks) await t();
    }),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/image.service', () => ({
  ingestImage: mockIngestImage,
  deleteImages: mockDeleteImages,
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({ limitConcurrency: mockLimitConcurrency }));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({
  env: { IMAGE_SCANNING_MAX_PER_RUN: 10, IMAGE_SCANNING_RETRY_DELAY: 5, DATABASE_IS_PROD: true },
}));

import { ingestImages } from '~/server/jobs/image-ingestion';

const ctx = {} as Parameters<typeof ingestImages.run>[0];
async function runJob<T extends { run: (ctx: any) => { result: Promise<unknown> } }>(
  job: T
): Promise<unknown> {
  return await job.run(ctx).result;
}

beforeEach(() => {
  callLog.length = 0;
  mockDbRead.jobQueue.findMany.mockClear();
  mockDbWrite.$queryRaw.mockClear();
  mockDbWrite.$executeRaw.mockClear();
  mockIngestImage.mockClear();
});

describe('ingest-images stale prune ordering', () => {
  it('deletes stale JobQueue rows before submitting any scans', async () => {
    await runJob(ingestImages);

    const firstDelete = callLog.indexOf('delete');
    const firstIngest = callLog.indexOf('ingest');

    expect(firstDelete).toBeGreaterThanOrEqual(0);
    expect(firstIngest).toBeGreaterThanOrEqual(0);
    expect(firstDelete).toBeLessThan(firstIngest);
  });
});
