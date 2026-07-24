import { describe, it, expect, vi, beforeEach } from 'vitest';

// The scanner sustains only a limited throughput, so the `ingest-images` retry/
// backfill cron must never submit more than IMAGE_SCANNING_MAX_PER_RUN images in
// a single run — even when the JobQueue backlog is far larger. This test drives
// the real job with a backlog larger than the cap and asserts the number of
// scan submissions (ingestImage calls) is bounded by the cap.

const {
  MOCK_CAP,
  TOTAL_QUEUE,
  mockDbRead,
  mockDbWrite,
  mockIngestImage,
  mockDeleteImages,
  mockLimitConcurrency,
} = vi.hoisted(() => {
  const MOCK_CAP = 100; // IMAGE_SCANNING_MAX_PER_RUN under test
  const TOTAL_QUEUE = 500; // simulated backlog, intentionally >> cap
    // Shared between the findMany mock (which honors `take`) and the $queryRaw
    // mock (which returns image rows for exactly the ids that were pulled).
    const pulled: { ids: number[] } = { ids: [] };
    return {
      MOCK_CAP,
      TOTAL_QUEUE,
      mockDbRead: {
        jobQueue: {
          // Simulate a DB LIMIT: return at most `take` rows from a backlog of
          // TOTAL_QUEUE, oldest-first. This is what bounds the run.
          findMany: vi.fn(async ({ take }: { take: number }) => {
            const n = Math.min(take, TOTAL_QUEUE);
            pulled.ids = Array.from({ length: n }, (_, i) => i + 1);
            return pulled.ids.map((entityId) => ({ entityId }));
          }),
        },
      },
      mockDbWrite: {
        // Tagged-template: return a Pending, immediately-eligible image row for
        // each pulled id so every pulled image is submitted this run.
        $queryRaw: vi.fn(async () =>
          pulled.ids.map((id) => ({
            id,
            url: `img-${id}`,
            type: 'image',
            width: 100,
            height: 100,
            prompt: null,
            scanRequestedAt: null,
            ingestion: 'Pending',
            retryCount: 0,
            isBackfill: false,
          }))
        ),
        $executeRaw: vi.fn(async () => 0),
      },
      mockIngestImage: vi.fn(async () => true),
      mockDeleteImages: vi.fn(async () => undefined),
      // Run tasks sequentially for deterministic assertions.
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
  env: {
    IMAGE_SCANNING_MAX_PER_RUN: MOCK_CAP,
    IMAGE_SCANNING_RETRY_DELAY: 5,
    DATABASE_IS_PROD: true,
  },
}));

import { ingestImages } from '~/server/jobs/image-ingestion';

const ctx = {} as Parameters<typeof ingestImages.run>[0];

// createJob wraps the fn so .run() returns { result, cancel }; await `.result`.
async function runJob<T extends { run: (ctx: any) => { result: Promise<unknown> } }>(
  job: T
): Promise<unknown> {
  return await job.run(ctx).result;
}

beforeEach(() => {
  mockDbRead.jobQueue.findMany.mockClear();
  mockDbWrite.$queryRaw.mockClear();
  mockDbWrite.$executeRaw.mockClear();
  mockIngestImage.mockClear();
});

describe('ingest-images per-run cap', () => {
  it('pulls the JobQueue with take = IMAGE_SCANNING_MAX_PER_RUN, oldest-first', async () => {
    await runJob(ingestImages);
    expect(mockDbRead.jobQueue.findMany).toHaveBeenCalledTimes(1);
    const arg = mockDbRead.jobQueue.findMany.mock.calls[0][0];
    expect(arg.take).toBe(MOCK_CAP);
    expect(arg.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('bounds scan submissions to the cap even when the backlog is much larger', async () => {
    const result = (await runJob(ingestImages)) as { sent: number };

    // Never submits more than the cap, despite TOTAL_QUEUE (500) waiting.
    expect(mockIngestImage.mock.calls.length).toBeLessThanOrEqual(MOCK_CAP);
    // All pulled images were eligible+submitted, so we hit the cap exactly.
    expect(mockIngestImage.mock.calls.length).toBe(MOCK_CAP);
    expect(result.sent).toBe(MOCK_CAP);
  });
});
