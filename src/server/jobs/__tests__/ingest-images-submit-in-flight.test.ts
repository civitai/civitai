import { describe, it, expect, vi, beforeEach } from 'vitest';

// The Image INSERT trigger (`trg_image_scan_queue`) queues a new image the moment the
// row lands, but `ingestImage` stamps `scanRequestedAt` only when its upload-path
// submit returns. A cron run landing inside that window read the NULL as "never
// submitted" and submitted a SECOND workflow for the same image — two scans, two
// callbacks, twice the orchestrator work. Measured on prod 2026-09-18: of 41,865
// images scanned in 12h, 166 carried two workflow ids, and 161 of those were created
// within 30s of a cron tick against a 9.8% uniform baseline.
//
// The grace must not swallow the case it sits next to: an image whose submit died
// without writing the row at all still has to be re-driven, so a skipped row stays in
// the JobQueue rather than pruning as stale.

const MINUTE = 60 * 1000;
// SUBMIT_IN_FLIGHT_GRACE in the job under test (minutes). IN_FLIGHT is inside it,
// SETTLED is past it but still well under the 30-min age-out.
const IN_FLIGHT = new Date();
const SETTLED = new Date(Date.now() - 5 * MINUTE);

const ROWS = [
  // 1: Pending, just created, never stamped -> its first submit may still be running.
  mkRow({ id: 1, ingestion: 'Pending', createdAt: IN_FLIGHT, scanRequestedAt: null }),
  // 2: Pending, past the grace, still never stamped -> its submit died silently; the
  //    cron is the only thing that will ever re-drive it.
  mkRow({ id: 2, ingestion: 'Pending', createdAt: SETTLED, scanRequestedAt: null }),
  // 3: Rescan, just created -> a rescan is an explicit request with no submit in
  //    flight, so the grace must not hold it back.
  mkRow({ id: 3, ingestion: 'Rescan', createdAt: IN_FLIGHT, scanRequestedAt: null }),
];

function mkRow(overrides: {
  id: number;
  ingestion: string;
  createdAt: Date;
  scanRequestedAt: Date | null;
  retryCount?: number;
}) {
  return {
    url: `img-${overrides.id}`,
    type: 'image',
    width: 100,
    height: 100,
    prompt: null,
    retryCount: 0,
    failureClass: null,
    isBackfill: false,
    ...overrides,
  };
}

const { execLog, mockIngestImage, mockDeleteImages, mockLimitConcurrency } = vi.hoisted(() => {
  const execLog: { sql: string; values: unknown[] }[] = [];
  return {
    execLog,
    mockIngestImage: vi.fn(async () => true),
    mockDeleteImages: vi.fn(async () => undefined),
    // Sequential for deterministic assertions.
    mockLimitConcurrency: vi.fn(async (tasks: Array<() => Promise<unknown>>) => {
      for (const t of tasks) await t();
    }),
  };
});

vi.mock('~/server/services/image.service', () => ({
  ingestImage: mockIngestImage,
  deleteImages: mockDeleteImages,
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({ limitConcurrency: mockLimitConcurrency }));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({
  env: {
    IMAGE_SCANNING_MAX_PER_RUN: 100,
    IMAGE_SCANNING_RETRY_DELAY: 5,
    IMAGE_SCANNING_PENDING_TIMEOUT: 30,
    DATABASE_IS_PROD: true,
  },
}));

import { ingestImages } from '~/server/jobs/image-ingestion';
import { dbMock } from '~/__tests__/mocks/db.mock';

dbMock.dbRead.jobQueue.findMany.mockImplementation(async () =>
  ROWS.map((row) => ({ entityId: row.id }))
);
dbMock.dbWrite.$queryRaw.mockImplementation(async () => ROWS);
dbMock.dbWrite.$executeRaw.mockImplementation(
  async (strings: TemplateStringsArray, ...values: unknown[]) => {
    execLog.push({ sql: strings.join('?'), values });
    return 0;
  }
);

const ctx = {} as Parameters<typeof ingestImages.run>[0];
async function runJob() {
  return (await ingestImages.run(ctx).result) as { submitInFlight: number; sent: number };
}

function sentIds() {
  return mockIngestImage.mock.calls.map((c) => (c[0] as { image: { id: number } }).image.id);
}
function targetIds(call?: { values: unknown[] }): number[] {
  return (call?.values.find(Array.isArray) as number[] | undefined) ?? [];
}
function pruneDelete() {
  return execLog.find((c) => c.sql.includes('DELETE FROM "JobQueue"'));
}

beforeEach(() => {
  execLog.length = 0;
  dbMock.dbRead.jobQueue.findMany.mockClear();
  dbMock.dbWrite.$queryRaw.mockClear();
  dbMock.dbWrite.$executeRaw.mockClear();
  mockIngestImage.mockClear();
});

describe('ingest-images submit-in-flight grace', () => {
  it('does NOT re-submit a just-created Pending image whose first submit has not returned', async () => {
    const result = await runJob();

    expect(sentIds()).not.toContain(1);
    expect(result.submitInFlight).toBe(1);
  });

  it('keeps the skipped image in the JobQueue so a silently-dead submit is still re-driven', async () => {
    await runJob();

    // Not processed and not waiting on a cooldown, so without the in-flight branch in
    // `waitingForRetryIds` this row prunes as stale and never scans.
    expect(targetIds(pruneDelete())).not.toContain(1);
  });

  it('still submits a Pending image that is past the grace and was never stamped', async () => {
    await runJob();

    expect(sentIds()).toContain(2);
  });

  it('does not hold back a Rescan image — the grace is for Pending submits only', async () => {
    await runJob();

    expect(sentIds()).toContain(3);
  });
});
