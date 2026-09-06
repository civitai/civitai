import { describe, it, expect, vi, beforeEach } from 'vitest';

// `remove-blocked-images` hard-deletes blocked media (row + S3) after a retention window.
// The window used to be clocked off the Image row: `updatedAt` for blockedFor='moderated',
// `createdAt` for everything else. `createdAt` is UPLOAD time, so a moderator block on an
// image older than the window was already past cutoff and got purged on the next hourly
// run — and the free-text moderator reasons ('CSAM', '14 year old', …) are exactly the
// cohort that took that branch, so NCMEC evidence disappeared before it could be reported.
//
// The clock is now the JobQueue row's `createdAt`, which trg_blocked_image_delete_queue
// writes at the moment ingestion flips to Blocked. These tests pin:
//   1. retention counts from the BLOCK, not the upload (the regression above);
//   2. an expired block is still deleted (the window didn't just become infinite);
//   3. media of a user with an open CSAM report is held — and excluded from the batch
//      rather than filtered out of it, so held rows can't sit at the head of the
//      oldest-first queue and starve deletion for everyone else;
//   4. the hold predicate itself — sent-but-unarchived still holds;
//   5. a report older than CSAM_HOLD_MAX_DAYS purges anyway and alerts, since the
//      send/archive pipeline has no retry limit and can strand a report indefinitely;
//   6. AiNotVerified and vanished rows are still swept out of the queue;
//   7. a non-prod database is never mass-deleted.

const DAY = 24 * 60 * 60 * 1000;
const EXPIRED = new Date(Date.now() - 8 * DAY); // past BLOCKED_IMAGE_RETENTION_DAYS (7)
const RECENT = new Date(Date.now() - 1 * DAY); // inside the retention window
const OLD_REPORT = new Date(Date.now() - 31 * DAY); // past CSAM_HOLD_MAX_DAYS (30)

const PLAIN_USER = 1;
const HELD_USER = 999; // open report, inside the ceiling
const STRANDED_USER = 888; // open report, past the ceiling

const QUEUE = [
  { entityId: 1, createdAt: EXPIRED }, // expired block -> delete
  { entityId: 2, createdAt: RECENT }, // recent block on an ancient upload -> wait
  { entityId: 3, createdAt: EXPIRED }, // AiNotVerified -> swept, never deleted
  { entityId: 4, createdAt: EXPIRED }, // no longer Blocked -> swept, never deleted
  { entityId: 5, createdAt: EXPIRED }, // live hold -> excluded from the batch
  { entityId: 6, createdAt: EXPIRED }, // hold past the ceiling -> purged + alerted
];
// The Image SELECT only ever returns still-Blocked rows; id 4 is absent by construction.
const IMAGES = [
  { id: 1, userId: PLAIN_USER, blockedFor: 'CSAM' },
  { id: 2, userId: PLAIN_USER, blockedFor: 'CSAM' },
  { id: 3, userId: PLAIN_USER, blockedFor: 'AiNotVerified' },
  { id: 5, userId: HELD_USER, blockedFor: 'CSAM' },
  { id: 6, userId: STRANDED_USER, blockedFor: 'CSAM' },
];

const {
  execLog,
  sqlLog,
  queueWhereLog,
  mockDbRead,
  mockDbWrite,
  mockDeleteImages,
  mockLogToAxiom,
  mockEnv,
  heldUsers,
} = vi.hoisted(() => {
  const execLog: { sql: string; values: unknown[] }[] = [];
  const sqlLog: string[] = [];
  const queueWhereLog: any[] = [];
  // Mutable so a test can vary which reports are open.
  const heldUsers: { userId: number; oldestReport: Date }[] = [];
  const mockEnv = {
    IMAGE_SCANNING_MAX_PER_RUN: 100,
    IMAGE_SCANNING_RETRY_DELAY: 5,
    IMAGE_SCANNING_PENDING_TIMEOUT: 30,
    DATABASE_IS_PROD: true,
  };
  const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    sqlLog.push(sql);
    if (sql.includes('FROM "CsamReport"')) return heldUsers;
    // Blocked images belonging to the still-held users.
    if (sql.includes('"userId" = ANY')) {
      const ids = (values.find(Array.isArray) as number[]) ?? [];
      return IMAGES.filter((i) => ids.includes(i.userId)).map((i) => ({ id: i.id }));
    }
    // The batch SELECT, scoped to whatever ids survived the queue exclusion.
    const ids = (values.find(Array.isArray) as number[]) ?? [];
    return IMAGES.filter((i) => ids.includes(i.id));
  };
  return {
    execLog,
    sqlLog,
    queueWhereLog,
    heldUsers,
    mockEnv,
    mockDbRead: {
      jobQueue: {
        findMany: vi.fn(async ({ where }: any) => {
          queueWhereLog.push(where);
          // Stand in for the DB actually applying the exclusion.
          const excluded: number[] = where?.entityId?.notIn ?? [];
          return QUEUE.filter((q) => !excluded.includes(q.entityId));
        }),
      },
      $queryRaw: vi.fn(queryRaw),
    },
    mockDbWrite: {
      $queryRaw: vi.fn(queryRaw),
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        execLog.push({ sql: strings.join('?'), values });
        return 0;
      }),
    },
    mockDeleteImages: vi.fn(async () => undefined),
    mockLogToAxiom: vi.fn(),
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
// Hand-listed rather than spread from the real module on purpose: image.service is ~8k
// lines and builds module-scope caches on import, which is what we're avoiding here.
vi.mock('~/server/services/image.service', () => ({
  ingestImage: vi.fn(async () => true),
  deleteImages: mockDeleteImages,
}));
vi.mock('~/server/utils/concurrency-helpers', () => ({ limitConcurrency: vi.fn(async () => []) }));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({ env: mockEnv }));

import { removeBlockedImages } from '~/server/jobs/image-ingestion';

const ctx = {} as Parameters<typeof removeBlockedImages.run>[0];
async function runJob() {
  return (await removeBlockedImages.run(ctx).result) as Partial<{
    deleted: number;
    staleRemoved: number;
    waitingForRetention: number;
    csamHeld: number;
    csamHoldExpired: number;
  }>;
}

function deletedIds() {
  return (mockDeleteImages.mock.calls[0]?.[0] as number[] | undefined) ?? [];
}
/** The options object this job hands `deleteImages` — the retraction intent lives here. */
function deleteOptions() {
  return mockDeleteImages.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
}
function queuePruneIds() {
  const call = execLog.find((c) => c.sql.includes('DELETE FROM "JobQueue"'));
  return (call?.values.find(Array.isArray) as number[] | undefined) ?? [];
}
function batchWhere() {
  // The last findMany is the batch fetch; earlier ones (if any) are hold lookups.
  return queueWhereLog[queueWhereLog.length - 1];
}

beforeEach(() => {
  execLog.length = 0;
  sqlLog.length = 0;
  queueWhereLog.length = 0;
  heldUsers.length = 0;
  heldUsers.push(
    { userId: HELD_USER, oldestReport: RECENT },
    { userId: STRANDED_USER, oldestReport: OLD_REPORT }
  );
  mockEnv.DATABASE_IS_PROD = true;
  mockDbRead.jobQueue.findMany.mockClear();
  mockDbRead.$queryRaw.mockClear();
  mockDbWrite.$queryRaw.mockClear();
  mockDbWrite.$executeRaw.mockClear();
  mockDeleteImages.mockClear();
  mockLogToAxiom.mockClear();
});

describe('remove-blocked-images retention clock', () => {
  it('counts retention from the block, not the upload', async () => {
    const result = await runJob();

    // id 2 was blocked a day ago. Under the old Image.createdAt clock its ancient upload
    // date would have made it deletable immediately; it must now wait out the window.
    expect(deletedIds()).not.toContain(2);
    expect(queuePruneIds()).not.toContain(2);
    expect(result.waitingForRetention).toBe(1);
  });

  it('still deletes a block that is past the window', async () => {
    await runJob();

    expect(deletedIds()).toContain(1);
    // Deleted rows leave the queue.
    expect(queuePruneIds()).toContain(1);
  });

  // This job is the ONE moderation flow allowed to ask the image-cache service to destroy the
  // shared stored object, not just the derived variants. Every other caller of `deleteImages`
  // (replaced-image reaping, deleted-user cleanup, the moderator bulk endpoint) omits the
  // option and gets today's behaviour. The intent has to be stated here, in words, or it does
  // not travel: `deleteImages` defaults it off at every layer below.
  it('asks for blob retraction, because this is a moderation takedown', async () => {
    await runJob();

    expect(mockDeleteImages).toHaveBeenCalledTimes(1);
    expect(deleteOptions()).toMatchObject({ retractPublicBlobs: true });
  });

  // The option is the third argument; `updatePosts` is the second and must keep its value.
  // Passing the options object in the wrong position would read as `updatePosts = {…}` —
  // truthy, so nothing visibly breaks, while the retraction silently never happens.
  it('leaves post updating on while doing so', async () => {
    await runJob();

    expect(mockDeleteImages.mock.calls[0]?.[1]).toBe(true);
  });

  it('holds media of a user with an open CSAM report', async () => {
    const result = await runJob();

    expect(deletedIds()).not.toContain(5);
    expect(result.csamHeld).toBe(1);
    // Held media stays queued so it resumes once the report is sent and archived —
    // it must not be swept as stale.
    expect(queuePruneIds()).not.toContain(5);
  });

  it('treats sent-but-unarchived as still open', async () => {
    await runJob();

    // Asserted against the SQL text because the predicate lives in raw SQL the mock cannot
    // evaluate. Narrowing this OR to an AND would silently stop holding the sent-but-
    // unarchived majority, which is the cohort the archive job is still working through.
    const holdSql = sqlLog.find((s) => s.includes('FROM "CsamReport"'));
    expect(holdSql).toMatch(/"reportSentAt" IS NULL\s+OR\s+"archivedAt" IS NULL/);
  });

  it('excludes held media from the batch instead of filtering it afterwards', async () => {
    await runJob();

    // The starvation guard: held ids never enter the 15k window, so they cannot sit at
    // the head of the oldest-first queue and consume it every run.
    expect(batchWhere()?.entityId?.notIn).toContain(5);
    // ...but only while the report is live; a stranded report must not be excluded.
    expect(batchWhere()?.entityId?.notIn ?? []).not.toContain(6);
    // The batch must stay scoped to this queue type — a widened where would delete
    // unrelated entities.
    expect(batchWhere()).toMatchObject({ type: 'BlockedImageDelete', entityType: 'Image' });
  });

  it('purges and alerts when a report outlives the ceiling', async () => {
    const result = await runJob();

    // The pipeline has no retry limit, so an abandoned report must not hold media forever.
    expect(deletedIds()).toContain(6);
    expect(result.csamHoldExpired).toBe(1);

    const alert = mockLogToAxiom.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((a) => a.subType === 'csam-hold-expired');
    expect(alert).toBeDefined();
    // Never truncated and scoped to the affected user: once the rows and their queue
    // entries are gone this log is the only record the evidence existed.
    expect(alert?.imageIds).toEqual([6]);
    expect(alert?.userIds).toEqual([STRANDED_USER]);
  });

  it('does not alert for a hold that is merely live', async () => {
    heldUsers.length = 0;
    heldUsers.push({ userId: HELD_USER, oldestReport: RECENT });
    const result = await runJob();

    expect(result.csamHoldExpired).toBe(0);
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('does not constrain the batch when no report is open', async () => {
    heldUsers.length = 0;
    const result = await runJob();

    expect(batchWhere()?.entityId).toBeUndefined();
    expect(result.csamHeld).toBe(0);
    // id 5 is now an ordinary expired block.
    expect(deletedIds()).toContain(5);
  });

  it('sweeps AiNotVerified and no-longer-blocked rows without deleting them', async () => {
    const result = await runJob();

    expect(deletedIds()).not.toContain(3);
    expect(deletedIds()).not.toContain(4);
    expect(queuePruneIds()).toEqual(expect.arrayContaining([3, 4]));
    expect(result.staleRemoved).toBe(2);
  });

  it('deletes nothing when the database is not prod', async () => {
    mockEnv.DATABASE_IS_PROD = false;
    await runJob();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(execLog).toHaveLength(0);
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });
});
