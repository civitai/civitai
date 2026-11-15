import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The orchestrator's scan slot refuses work when full rather than queueing it, so the
// `ingest-images` retry/backfill cron must bound what one run sends and spread it out:
// - the pull is capped at IMAGE_SCANNING_MAX_PER_RUN rows, oldest first;
// - sends are capped at IMAGE_SCANNING_RETRY_MAX_PER_RUN across all lanes, each lane keeping a
//   floor so a big Pending backlog can't starve Error retries;
// - above a small burst, submit starts are spaced evenly across the run, not fired at once;
// - rows past the send cap stay in the JobQueue for the next run.
// These drive the real job with the REAL limitConcurrency; only the DB and ingestImage are mocked.

type Row = {
  id: number;
  ingestion: 'Pending' | 'Error';
  scanRequestedAt: Date | null;
  createdAt: Date;
};

const { env, queue, mockDbRead, mockDbWrite, mockIngestImage, mockDeleteImages, starts } =
  vi.hoisted(() => {
    const queue: { rows: Row[]; pulled: Row[] } = { rows: [], pulled: [] };
    const starts: { id: number; at: number }[] = [];
    return {
      env: {
        IMAGE_SCANNING_MAX_PER_RUN: 100,
        IMAGE_SCANNING_RETRY_MAX_PER_RUN: 200,
        IMAGE_SCANNING_RETRY_DELAY: 5,
        IMAGE_SCANNING_PENDING_TIMEOUT: 60 * 24,
        DATABASE_IS_PROD: true,
      },
      queue,
      starts,
      mockDbRead: {
        jobQueue: {
          // A DB LIMIT over the queue, oldest first (queue.rows is kept in queue order).
          findMany: vi.fn(async ({ take }: { take: number }) => {
            queue.pulled = queue.rows.slice(0, take);
            return queue.pulled.map((r) => ({ entityId: r.id }));
          }),
        },
      },
      mockDbWrite: {
        // Image rows come back in REVERSE queue order: `id = ANY(...)` sets no order, and the
        // job must not let that decide which rows the send cap reaches.
        $queryRaw: vi.fn(async () =>
          [...queue.pulled].reverse().map((r) => ({
            id: r.id,
            url: `img-${r.id}`,
            type: 'image',
            width: 100,
            height: 100,
            prompt: null,
            scanRequestedAt: r.scanRequestedAt,
            createdAt: r.createdAt,
            ingestion: r.ingestion,
            retryCount: 0,
            failureClass: null,
            failureReason: null,
            rateLimitedSince: null,
            resubmitted: false,
            isBackfill: false,
          }))
        ),
        $executeRaw: vi.fn(async () => 0),
      },
      mockIngestImage: vi.fn(async ({ image }: { image: { id: number } }) => {
        starts.push({ id: image.id, at: Date.now() });
        return true;
      }),
      mockDeleteImages: vi.fn(async () => undefined),
    };
  });

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/services/image.service', () => ({
  ingestImage: mockIngestImage,
  deleteImages: mockDeleteImages,
}));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({ env }));

import { ingestImages } from '~/server/jobs/image-ingestion';

type RunResult = {
  sent: number;
  sentUserPending: number;
  sentError: number;
  sendable: number;
  deferredByCap: number;
  deferredUserPending: number;
  deferredError: number;
};

const PACE_WINDOW_MS = 3 * 60 * 1000;
const RUN_START = new Date('2026-11-15T12:00:00Z');

function rows(n: number, ingestion: Row['ingestion'], firstId = 1): Row[] {
  const longAgo = new Date(RUN_START.getTime() - 3 * 60 * 60 * 1000);
  return Array.from({ length: n }, (_, i) => ({
    id: firstId + i,
    ingestion,
    // Error rows need a past scan for their retry delay to have elapsed; Pending never sent.
    scanRequestedAt: ingestion === 'Error' ? longAgo : null,
    createdAt: longAgo,
  }));
}

async function runJob(): Promise<RunResult> {
  const pending = ingestImages.run({} as Parameters<typeof ingestImages.run>[0]).result;
  await vi.runAllTimersAsync();
  return (await pending) as RunResult;
}

function deletedJobQueueIds(): number[] {
  // The stale prune is the only JobQueue DELETE; its id array is the template's array value.
  return mockDbWrite.$executeRaw.mock.calls
    .filter((call) => String((call[0] as TemplateStringsArray).join('')).includes('JobQueue'))
    .flatMap((call) => call.slice(1).filter(Array.isArray).flat() as number[]);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(RUN_START);
  env.IMAGE_SCANNING_MAX_PER_RUN = 100;
  env.IMAGE_SCANNING_RETRY_MAX_PER_RUN = 200;
  queue.rows = [];
  starts.length = 0;
  mockDbRead.jobQueue.findMany.mockClear();
  mockDbWrite.$queryRaw.mockClear();
  mockDbWrite.$executeRaw.mockClear();
  mockIngestImage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ingest-images per-run cap', () => {
  it('pulls the JobQueue with take = IMAGE_SCANNING_MAX_PER_RUN, oldest-first', async () => {
    queue.rows = rows(5, 'Pending');
    await runJob();
    expect(mockDbRead.jobQueue.findMany).toHaveBeenCalledTimes(1);
    const arg = mockDbRead.jobQueue.findMany.mock.calls[0][0] as {
      take: number;
      orderBy: unknown;
    };
    expect(arg.take).toBe(100);
    expect(arg.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('bounds scan submissions to the pull cap even when the backlog is much larger', async () => {
    queue.rows = rows(500, 'Pending');
    const result = await runJob();
    expect(mockIngestImage).toHaveBeenCalledTimes(100);
    expect(result.sent).toBe(100);
  });
});

describe('ingest-images retry pacing', () => {
  it('sends a big backlog as a capped batch of the oldest rows, spaced across the run', async () => {
    env.IMAGE_SCANNING_MAX_PER_RUN = 300;
    env.IMAGE_SCANNING_RETRY_MAX_PER_RUN = 40;
    queue.rows = rows(300, 'Pending');

    const result = await runJob();

    expect(mockIngestImage).toHaveBeenCalledTimes(40);
    expect(result.sent).toBe(40);
    expect(result.sendable).toBe(300);
    expect(result.deferredByCap).toBe(260);
    expect(result.deferredUserPending).toBe(260);
    // The oldest 40 by queue order, though the image rows came back reversed.
    expect(starts.map((s) => s.id).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 40 }, (_, i) => i + 1)
    );

    // Starts are spread evenly: one per window / 40, never two inside one interval, the
    // first at the start of the run and the last inside the window.
    const interval = PACE_WINDOW_MS / 40;
    const at = starts.map((s) => s.at - RUN_START.getTime());
    expect(at[0]).toBe(0);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(interval);
    expect(at[at.length - 1]).toBeLessThan(PACE_WINDOW_MS);
    // No more than one start in any 1s span: the burst is gone.
    expect(new Set(at.map((t) => Math.floor(t / 1000))).size).toBe(40);

    // The 260 deferred rows were not pruned from the JobQueue.
    const deleted = new Set(deletedJobQueueIds());
    for (let id = 41; id <= 300; id++) expect(deleted.has(id)).toBe(false);
  });

  it('sends a small backlog all at once', async () => {
    queue.rows = rows(10, 'Pending');

    const result = await runJob();

    expect(mockIngestImage).toHaveBeenCalledTimes(10);
    expect(result.deferredByCap).toBe(0);
    expect(starts.every((s) => s.at === RUN_START.getTime())).toBe(true);
  });

  it('still sends Error retries when the Pending backlog alone is past the cap', async () => {
    env.IMAGE_SCANNING_MAX_PER_RUN = 1000;
    env.IMAGE_SCANNING_RETRY_MAX_PER_RUN = 40;
    queue.rows = [...rows(300, 'Pending'), ...rows(30, 'Error', 1001)];

    const result = await runJob();

    // cap 40 over 4 lanes: a floor of 10 each; Error takes its 10, Pending its 10 plus the
    // 20 the empty backfill and rescan lanes leave.
    expect(result.sentError).toBe(10);
    expect(result.sentUserPending).toBe(30);
    expect(result.deferredError).toBe(20);
    expect(result.deferredUserPending).toBe(270);
    expect(starts.filter((s) => s.id > 1000).map((s) => s.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => 1001 + i)
    );
  });
});
