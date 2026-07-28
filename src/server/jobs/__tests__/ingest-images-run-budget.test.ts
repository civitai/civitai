import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The `ingest-images` cron was killed at its ~5-min job lock before it ever reached
// the metric-recording tail: each 250-image chunk submitted sequentially inside a
// 3x in-batch retry, so a run vastly overshot the lock, recorded nothing, and
// re-loaded the same oldest rows every run (the Error backlog never drained). The fix
// gives `sendImagesForScanBulk` (1) bounded per-image concurrency, (2) a shared run
// deadline that stops STARTING new submits once the budget is spent, and (3) honors
// cancellation — all as a single pass (no in-batch retry). These tests exercise that
// helper directly with the REAL limitConcurrency (only ingestImage is mocked).

const { mockIngestImage, mockDeleteImages, mockDbRead, mockDbWrite } = vi.hoisted(() => ({
  mockIngestImage: vi.fn(async () => true),
  mockDeleteImages: vi.fn(async () => undefined),
  mockDbRead: { jobQueue: { findMany: vi.fn(async () => []) } },
  mockDbWrite: { $queryRaw: vi.fn(async () => []), $executeRaw: vi.fn(async () => 0) },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/image.service', () => ({
  ingestImage: mockIngestImage,
  deleteImages: mockDeleteImages,
}));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({
  env: {
    IMAGE_SCANNING_MAX_PER_RUN: 1000,
    IMAGE_SCANNING_RETRY_DELAY: 5,
    IMAGE_SCANNING_PENDING_TIMEOUT: 60 * 24,
    DATABASE_IS_PROD: true,
  },
}));

// NOTE: concurrency-helpers is intentionally NOT mocked — these tests rely on the real
// limitConcurrency to observe genuine parallelism and early-exit behavior.
import { sendImagesForScanBulk } from '~/server/jobs/image-ingestion';
import type { JobContext } from '~/server/jobs/job';
import type { IngestImageInput } from '~/server/schema/image.schema';

function makeImages(n: number): IngestImageInput[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, url: `img-${i + 1}` }));
}

beforeEach(() => {
  vi.useFakeTimers();
  mockIngestImage.mockReset();
  mockIngestImage.mockImplementation(async () => true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendImagesForScanBulk run budget + concurrency + cancel', () => {
  it('stops early once the run budget is exceeded and still returns', async () => {
    const images = makeImages(50);
    // Deadline already in the past: no submit should start, and the helper must still
    // resolve cleanly (this is what lets the job reach its metric/return tail).
    const result = await sendImagesForScanBulk(images, { deadline: Date.now() - 1 });

    expect(result).toEqual({ sent: [], failed: [] });
    expect(mockIngestImage).not.toHaveBeenCalled();
  });

  it('submits with real bounded concurrency, not one-at-a-time', async () => {
    const images = makeImages(50);

    let active = 0;
    let maxActive = 0;
    const resolvers: Array<(v: boolean) => void> = [];
    mockIngestImage.mockImplementation(() => {
      active++;
      if (active > maxActive) maxActive = active;
      return new Promise<boolean>((resolve) => {
        resolvers.push((v) => {
          active--;
          resolve(v);
        });
      });
    });

    const p = sendImagesForScanBulk(images);

    // Flush the microtask queue so limitConcurrency starts its full initial batch.
    for (let i = 0; i < 10; i++) await Promise.resolve();

    // Bounded concurrency: exactly INGEST_SUBMIT_CONCURRENCY (20) submits are in
    // flight at once — far above the old effective ~4, and never one-at-a-time.
    expect(maxActive).toBe(20);
    expect(mockIngestImage.mock.calls.length).toBe(20);

    // Drain: resolve in-flight submits, letting limitConcurrency pull the rest.
    while (resolvers.length) {
      const resolve = resolvers.shift();
      resolve?.(true);
      await Promise.resolve();
    }
    const result = await p;
    expect(result.sent.length).toBe(50);
  });

  it('stops starting new submits once the run is canceled', async () => {
    const images = makeImages(50);
    const ctx = { status: 'running' as 'running' | 'canceled' };

    // Flip to canceled on the very first submit; every task started afterward must
    // short-circuit instead of grinding through the whole list detached.
    mockIngestImage.mockImplementation(async () => {
      ctx.status = 'canceled';
      return true;
    });

    const result = await sendImagesForScanBulk(images, { ctx: ctx as unknown as JobContext });

    expect(mockIngestImage.mock.calls.length).toBeLessThan(images.length);
    expect(result.sent.length).toBeLessThan(images.length);
  });
});
