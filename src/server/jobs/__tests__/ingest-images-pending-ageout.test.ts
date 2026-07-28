import { describe, it, expect, vi, beforeEach } from 'vitest';

// A scan verdict returns via the fire-and-forget /image-scan-result webhook, which
// flips ingestion Pending -> Scanned/Blocked/Error. A fraction of scans never call
// back (dropped callback, or a stuck/unassigned workflow) and neither civitai nor
// the orchestrator times that out, so those images stay ingestion='Pending' forever
// and the retry cron re-drives them with no ceiling. The `ingest-images` cron now
// ages out a too-long-Pending NON-backfill image to Error, routing it into the
// existing capped Error-retry path so it can't be Pending forever.
//
// The age-out clock MUST be `createdAt`, not `scanRequestedAt`: `ingestImage` resets
// `scanRequestedAt = now` on every re-send, so an age test keyed on it never fires.
// These tests drive the real job with a controlled row set and assert:
//   1. an old (past-threshold) non-backfill Pending image is flipped to Error;
//   2. a fresh (under-threshold) Pending image is NOT flipped, and is still sent;
//   3. an old BACKFILL Pending image is NOT prematurely terminalized;
//   4. an aged-out image is NOT re-sent as Pending and stays in the JobQueue so it
//      enters the capped Error-retry, while an at-cap Error image is pruned
//      (terminal) — i.e. the loop is bounded, not infinite.

const HOUR = 60 * 60 * 1000;
// IMAGE_SCANNING_PENDING_TIMEOUT (minutes) under test. Inlined in the vi.mock env
// factory below (mock factories are hoisted above module consts, so they can't
// close over this) — OLD/FRESH are chosen relative to it: OLD (2h) is past it,
// FRESH (now) is under it.
const PENDING_TIMEOUT_MIN = 30;

// Fixture rows returned by the image SELECT. Fields mirror IngestImageRow.
const OLD = new Date(Date.now() - 2 * HOUR); // past the 30-min age-out threshold
const FRESH = new Date(); // well under the threshold
const OLD_SCAN = new Date(Date.now() - 2 * HOUR); // past the 60-min Error retry delay

const ROWS = [
  // 1: old, non-backfill, Pending  -> AGED OUT to Error (not sent, kept in queue)
  mkRow({ id: 1, ingestion: 'Pending', createdAt: OLD, isBackfill: false, scanRequestedAt: null }),
  // 2: fresh, non-backfill, Pending -> NOT aged out; sent this run
  mkRow({ id: 2, ingestion: 'Pending', createdAt: FRESH, isBackfill: false, scanRequestedAt: null }),
  // 3: old, BACKFILL, Pending       -> NOT aged out (backfill excluded); sent low-pri
  mkRow({ id: 3, ingestion: 'Pending', createdAt: OLD, isBackfill: true, scanRequestedAt: null }),
  // 4: Error, under the cap, cooled  -> re-tried via the Error lane (proves the
  //    aged-out target lands in a working, capped retry path)
  mkRow({
    id: 4,
    ingestion: 'Error',
    createdAt: OLD,
    isBackfill: false,
    scanRequestedAt: OLD_SCAN,
    retryCount: 0,
  }),
  // 5: Error, at the historical 9-cap -> NOT retried; becomes stale + pruned
  //    (terminal) — the retry loop is bounded.
  mkRow({
    id: 5,
    ingestion: 'Error',
    createdAt: OLD,
    isBackfill: false,
    scanRequestedAt: OLD_SCAN,
    retryCount: 9,
  }),
];

function mkRow(overrides: {
  id: number;
  ingestion: string;
  createdAt: Date;
  isBackfill: boolean;
  scanRequestedAt: Date | null;
  retryCount?: number;
  failureClass?: string | null;
}) {
  return {
    url: `img-${overrides.id}`,
    type: 'image',
    width: 100,
    height: 100,
    prompt: null,
    retryCount: 0,
    failureClass: null,
    ...overrides,
  };
}

const { execLog, mockDbRead, mockDbWrite, mockIngestImage, mockDeleteImages, mockLimitConcurrency } =
  vi.hoisted(() => {
    const execLog: { sql: string; values: unknown[] }[] = [];
    return {
      execLog,
      mockDbRead: {
        jobQueue: {
          // Return one queue row per fixture id, oldest-first.
          findMany: vi.fn(async () => [1, 2, 3, 4, 5].map((entityId) => ({ entityId }))),
        },
      },
      mockDbWrite: {
        // Image SELECT -> the fixture rows.
        $queryRaw: vi.fn(async () => ROWS),
        // Record every write so the test can distinguish the age-out UPDATE
        // (contains 'Pending'), the exhaustedRescan UPDATE ('Rescan'), and the
        // JobQueue prune DELETE, plus inspect the id array each targets.
        $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
          execLog.push({ sql: strings.join('?'), values });
          return 0;
        }),
      },
      mockIngestImage: vi.fn(async () => true),
      mockDeleteImages: vi.fn(async () => undefined),
      // Sequential for deterministic assertions.
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
    IMAGE_SCANNING_MAX_PER_RUN: 100,
    IMAGE_SCANNING_RETRY_DELAY: 5,
    IMAGE_SCANNING_PENDING_TIMEOUT: 30, // must equal PENDING_TIMEOUT_MIN above
    DATABASE_IS_PROD: true,
  },
}));

import { ingestImages } from '~/server/jobs/image-ingestion';

const ctx = {} as Parameters<typeof ingestImages.run>[0];
async function runJob<T extends { run: (ctx: any) => { result: Promise<unknown> } }>(
  job: T
): Promise<unknown> {
  return await job.run(ctx).result;
}

// Ids passed to ingestImage this run (the images actually (re-)sent for scanning).
function sentIds() {
  return mockIngestImage.mock.calls.map((c) => (c[0] as { image: { id: number } }).image.id);
}
// The id array targeted by a raw write is the sole array among its interpolated
// values (the UPDATE interpolates only the ids; the DELETE also interpolates the
// enum type/entityType strings first).
function targetIds(call?: { values: unknown[] }): number[] {
  return (call?.values.find(Array.isArray) as number[] | undefined) ?? [];
}
// The age-out UPDATE: flips Pending -> Error. Distinguished from the exhaustedRescan
// UPDATE by the guarded status literal in the SQL text.
function ageOutUpdate() {
  return execLog.find((c) => c.sql.includes('UPDATE "Image"') && c.sql.includes("'Pending'"));
}
function pruneDelete() {
  return execLog.find((c) => c.sql.includes('DELETE FROM "JobQueue"'));
}

beforeEach(() => {
  execLog.length = 0;
  mockDbRead.jobQueue.findMany.mockClear();
  mockDbWrite.$queryRaw.mockClear();
  mockDbWrite.$executeRaw.mockClear();
  mockIngestImage.mockClear();
});

describe('ingest-images pending age-out', () => {
  it('flips an old, non-backfill Pending image to Error (guarded on ingestion=Pending)', async () => {
    const result = (await runJob(ingestImages)) as { agedOutPending: number };

    const update = ageOutUpdate();
    expect(update).toBeDefined();
    // Bound UPDATE targeting exactly the aged-out id, guarded on the current status
    // so a concurrent verdict is never clobbered.
    expect(targetIds(update)).toEqual([1]);
    expect(update!.sql).toContain("ingestion = 'Pending'::\"ImageIngestionStatus\"");
    expect(result.agedOutPending).toBe(1);
  });

  it('does NOT flip a fresh (under-threshold) Pending image, and still sends it', async () => {
    await runJob(ingestImages);

    const update = ageOutUpdate();
    expect(targetIds(update)).not.toContain(2);
    // The fresh Pending image is still submitted for scanning this run.
    expect(sentIds()).toContain(2);
  });

  it('does NOT terminalize an old BACKFILL Pending image', async () => {
    const result = (await runJob(ingestImages)) as { agedOutPending: number };

    const update = ageOutUpdate();
    // Only id 1 aged out; the old backfill id 3 is excluded.
    expect(targetIds(update)).toEqual([1]);
    expect(targetIds(update)).not.toContain(3);
    expect(result.agedOutPending).toBe(1);
    // Backfill still scans via its (low-priority) lane rather than being dropped.
    expect(sentIds()).toContain(3);
  });

  it('aged-out image enters the capped Error-retry (not re-sent, kept in queue); at-cap Error is terminal', async () => {
    await runJob(ingestImages);

    // Aged-out id 1 is flipped, NOT re-driven as Pending this run.
    expect(sentIds()).not.toContain(1);
    // ...and it is NOT pruned from the JobQueue — it stays so next run it is
    // re-pulled as Error and retried through the existing capped Error path.
    const del = pruneDelete();
    expect(del).toBeDefined();
    expect(targetIds(del)).not.toContain(1);

    // An Error image under the cap IS retried (bounded retry path is live)...
    expect(sentIds()).toContain(4);
    // ...and an Error image at the 9-cap is NOT retried and IS pruned — terminal,
    // so the retry loop is bounded, never infinite.
    expect(sentIds()).not.toContain(5);
    expect(targetIds(del)).toContain(5);
  });
});
