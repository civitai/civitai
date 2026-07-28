import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A single ingestImage whose orchestrator submit never resolves must NOT stall the
// whole run. The sends run sequentially within a chunk, so an unbounded hang there
// meant the run never completed, got killed, recorded no job metric, and re-loaded
// the same stuck oldest rows forever (the backlog never drained). This drives the
// real job with one image whose ingestImage never settles and asserts the run still
// completes: the hung image is failed (bounded by the per-image timeout) while the
// others are submitted.

const { mockDbRead, mockDbWrite, mockIngestImage, mockDeleteImages, mockLimitConcurrency } =
  vi.hoisted(() => {
    const pulled: { ids: number[] } = { ids: [] };
    return {
      mockDbRead: {
        jobQueue: {
          findMany: vi.fn(async ({ take }: { take: number }) => {
            pulled.ids = Array.from({ length: take }, (_, i) => i + 1);
            return pulled.ids.map((entityId) => ({ entityId }));
          }),
        },
      },
      mockDbWrite: {
        $queryRaw: vi.fn(async () =>
          pulled.ids.map((id) => ({
            id,
            url: `img-${id}`,
            type: 'image',
            width: 100,
            height: 100,
            prompt: null,
            scanRequestedAt: null,
            createdAt: new Date(),
            ingestion: 'Pending',
            retryCount: 0,
            failureClass: null,
            isBackfill: false,
          }))
        ),
        $executeRaw: vi.fn(async () => 0),
      },
      // Image id 2 hangs forever; all others succeed. A hung submit must not stall
      // or reject the run — the per-image timeout turns it into a failed send.
      mockIngestImage: vi.fn(({ image }: { image: { id: number } }) =>
        image.id === 2 ? new Promise<boolean>(() => undefined) : Promise.resolve(true)
      ),
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
  env: {
    IMAGE_SCANNING_MAX_PER_RUN: 3,
    IMAGE_SCANNING_RETRY_DELAY: 5,
    IMAGE_SCANNING_PENDING_TIMEOUT: 60 * 24,
    DATABASE_IS_PROD: true,
  },
}));

import { ingestImages } from '~/server/jobs/image-ingestion';

const ctx = {} as Parameters<typeof ingestImages.run>[0];
async function runJob(): Promise<unknown> {
  return await ingestImages.run(ctx).result;
}

beforeEach(() => {
  vi.useFakeTimers();
  mockDbRead.jobQueue.findMany.mockClear();
  mockDbWrite.$queryRaw.mockClear();
  mockDbWrite.$executeRaw.mockClear();
  mockIngestImage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ingest-images send resilience', () => {
  it('completes the run and submits the healthy images even when one ingestImage hangs', async () => {
    const p = runJob() as Promise<{
      sent: number;
      sentUserPending: number;
      failedSends: number;
    }>;

    // Advance past the per-image timeout for every in-batch retry of the hung image
    // (3 retries * 60s) so the run drains to completion instead of hanging.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);

    const result = await p;

    // The two healthy images (ids 1 and 3) were submitted; the hung image (id 2) is
    // counted as a failed send, not a run-stalling hang.
    expect(result.sentUserPending).toBe(2);
    expect(result.failedSends).toBe(1);
    // The hung image was attempted and retried in-batch rather than aborting the loop.
    const hungAttempts = mockIngestImage.mock.calls.filter((c) => c[0].image.id === 2).length;
    expect(hungAttempts).toBeGreaterThan(1);
  });
});
