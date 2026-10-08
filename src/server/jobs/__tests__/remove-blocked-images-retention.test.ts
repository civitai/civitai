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
//   7. a non-prod database is never mass-deleted;
//   8. an image under a pending appeal is held until the appeal is resolved;
//   9. an image flagged for CSAM review is held until the flag is resolved.

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
  { entityId: 7, createdAt: EXPIRED }, // under appeal when a test marks it so -> held
  { entityId: 8, createdAt: EXPIRED }, // flagged for CSAM review when a test marks it so -> held
];
// Every image here is a MODERATOR TAKEDOWN, so each carries the `ModActivity` row the job now
// requires before it will ask for blob retraction — dated after its own block, as a real one
// would be. This file is about the retention CLOCK; which images qualify for retraction, and what
// happens to the ones that do not, is `blob-retraction-writer-reachability.test.ts`.
const MOD_ACTIVITY = QUEUE.map((q) => ({
  entityId: q.entityId,
  lastActedAt: new Date(q.createdAt.getTime() + 1000),
}));
// The Image SELECT only ever returns still-Blocked rows; id 4 is absent by construction.
const IMAGES = [
  { id: 1, userId: PLAIN_USER, blockedFor: 'CSAM' },
  { id: 2, userId: PLAIN_USER, blockedFor: 'CSAM' },
  { id: 3, userId: PLAIN_USER, blockedFor: 'AiNotVerified' },
  { id: 5, userId: HELD_USER, blockedFor: 'CSAM' },
  { id: 6, userId: STRANDED_USER, blockedFor: 'CSAM' },
  { id: 7, userId: PLAIN_USER, blockedFor: 'moderated' },
  { id: 8, userId: PLAIN_USER, blockedFor: 'moderated' },
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
  appealedIds,
  csamFlaggedIds,
  withoutModActivity,
} = vi.hoisted(() => {
  const execLog: { sql: string; values: unknown[] }[] = [];
  const sqlLog: string[] = [];
  const queueWhereLog: any[] = [];
  // Mutable so a test can vary which reports are open.
  const heldUsers: { userId: number; oldestReport: Date }[] = [];
  const appealedIds: number[] = [];
  const csamFlaggedIds: number[] = [];
  // Images whose block has no moderator takedown on record, so they take the non-retracting call.
  const withoutModActivity: number[] = [];
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
    // Answers with whichever review flags the query actually names, so dropping one from the
    // SQL is what stops that population being held.
    const reviewFlags = sql.match(/"needsReview" IN \(([^)]*)\)/);
    if (reviewFlags) {
      const named = [...reviewFlags[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      return [
        ...appealedIds.map((id) => ({ id, needsReview: 'appeal' })),
        ...csamFlaggedIds.map((id) => ({ id, needsReview: 'csam' })),
      ].filter((r) => named.includes(r.needsReview));
    }
    // The moderator-activity lookup that gates blob retraction. Routed before the catch-all
    // below, which would otherwise answer it with Image rows.
    if (sql.includes('FROM "ModActivity"')) {
      const ids = (values[0] as number[]) ?? [];
      return MOD_ACTIVITY.filter(
        (m) => ids.includes(m.entityId) && !withoutModActivity.includes(m.entityId)
      );
    }
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
    appealedIds,
    csamFlaggedIds,
    withoutModActivity,
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
    mockDeleteImages: vi.fn(async (ids: number[], ..._rest: unknown[]) =>
      ids.map((id) => ({ id }))
    ),
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

import { purgeHoldGuard, removeBlockedImages } from '~/server/jobs/image-ingestion';

const ctx = {} as Parameters<typeof removeBlockedImages.run>[0];
async function runJob() {
  return (await removeBlockedImages.run(ctx).result) as Partial<{
    deleted: number;
    heldAtDelete: number;
    staleRemoved: number;
    waitingForRetention: number;
    csamHeld: number;
    csamHoldExpired: number;
    appealHeld: number;
    csamReviewHeld: number;
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
  appealedIds.length = 0;
  csamFlaggedIds.length = 0;
  withoutModActivity.length = 0;
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

  it('holds an image whose appeal is still pending', async () => {
    appealedIds.push(7);
    const result = await runJob();

    // Deleting it leaves the Appeal row Pending forever against an image that no longer
    // exists — and a fee-paying user with no resolution and no refund.
    expect(deletedIds()).not.toContain(7);
    expect(result.appealHeld).toBe(1);
    // Must stay queued: once the appeal is rejected the image is still Blocked, and the
    // queue trigger only fires on the transition INTO Blocked, so nothing would re-enqueue it.
    expect(queuePruneIds()).not.toContain(7);
    // Excluded from the batch like CSAM holds, so held rows cannot starve the window.
    expect(batchWhere()?.entityId?.notIn).toEqual(expect.arrayContaining([5, 7]));
  });

  it('deletes the image once the appeal is no longer pending', async () => {
    const result = await runJob();

    expect(deletedIds()).toContain(7);
    expect(result.appealHeld).toBe(0);
  });

  it('holds a blocked image flagged for review with no other hold on its owner', async () => {
    heldUsers.length = 0;
    csamFlaggedIds.push(8);
    const result = await runJob();

    expect(deletedIds()).not.toContain(8);
    expect(result.csamReviewHeld).toBe(1);
    expect(queuePruneIds()).not.toContain(8);
    expect(batchWhere()?.entityId?.notIn).toEqual([8]);
    // Neither population stands in for the other.
    expect(result.appealHeld).toBe(0);
    expect(result.csamHeld).toBe(0);
  });

  // Neither mock evaluates these, so they are pinned here. Dropping the ingestion predicate puts
  // every flagged image on the site, blocked or not, into the batch's notIn list; reading from
  // the replica misses a flag set inside the lag window.
  it('reads the review hold from the primary, Blocked images only', async () => {
    await runJob();

    const isHoldSql = (s: string) => s.includes('"needsReview" IN');
    const sqlOf = (calls: unknown[][]) =>
      calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    const onWrite = sqlOf(mockDbWrite.$queryRaw.mock.calls).filter(isHoldSql);
    const onRead = sqlOf(mockDbRead.$queryRaw.mock.calls).filter(isHoldSql);

    expect(onRead).toEqual([]);
    expect(onWrite).toHaveLength(1);
    expect(onWrite[0]).toMatch(
      /WHERE "needsReview" IN \('appeal', 'csam'\)\s+AND ingestion = 'Blocked'::"ImageIngestionStatus"\s*$/
    );
  });

  it('holds appealed and CSAM-flagged images side by side', async () => {
    appealedIds.push(7);
    csamFlaggedIds.push(8);
    const result = await runJob();

    expect(deletedIds()).not.toContain(7);
    expect(deletedIds()).not.toContain(8);
    expect(result).toMatchObject({ appealHeld: 1, csamReviewHeld: 1 });
    expect(batchWhere()?.entityId?.notIn).toEqual(expect.arrayContaining([5, 7, 8]));
  });

  it('deletes the image once the CSAM flag is resolved', async () => {
    const result = await runJob();

    expect(deletedIds()).toContain(8);
    expect(result.csamReviewHeld).toBe(0);
  });

  // The guard's own semantics are pinned against Postgres in
  // remove-blocked-images-hold-guard.behavior.test.ts; this pins that the job hands it over.
  it('re-checks its holds on the delete, exempting only the report holds it expired', async () => {
    await runJob();

    const onlyWhere = deleteOptions()?.onlyWhere as { sql: string; values: unknown[] } | undefined;
    expect(onlyWhere?.sql).toBe(purgeHoldGuard([]).sql);
    expect(onlyWhere?.values).toEqual([[STRANDED_USER]]);
  });

  it('guards the non-retracting delete as well as the takedown one', async () => {
    withoutModActivity.push(1);
    await runJob();

    const guards = mockDeleteImages.mock.calls.map(
      (c) => (c[2] as { onlyWhere?: { sql: string; values: unknown[] } } | undefined)?.onlyWhere
    );
    expect(guards).toHaveLength(2);
    for (const guard of guards) {
      expect(guard?.sql).toBe(purgeHoldGuard([]).sql);
      expect(guard?.values).toEqual([[STRANDED_USER]]);
    }
  });

  it('keeps the queue row of an image a hold kept at delete time', async () => {
    mockDeleteImages.mockImplementationOnce(async (ids: number[]) =>
      ids.filter((id) => id !== 1).map((id) => ({ id }))
    );
    const result = await runJob();

    expect(deletedIds()).toContain(1);
    expect(queuePruneIds()).not.toContain(1);
    expect(queuePruneIds()).toContain(6);
    expect(result).toMatchObject({
      deleted: deletedIds().length - 1,
      heldAtDelete: 1,
      retracted: deletedIds().length - 1,
    });
  });

  // The returned counts are of images the DELETE removed, not of the candidates it was given.
  it('counts an expired-hold image the guard kept as not purged', async () => {
    mockDeleteImages.mockImplementationOnce(async (ids: number[]) =>
      ids.filter((id) => id !== 6).map((id) => ({ id }))
    );
    const result = await runJob();

    expect(deletedIds()).toContain(6);
    expect(result).toMatchObject({ csamHoldExpired: 0, heldAtDelete: 1 });
  });

  it('counts a kept image on the non-retracting call as not deleted', async () => {
    withoutModActivity.push(1);
    mockDeleteImages
      .mockImplementationOnce(async (ids: number[]) => ids.map((id) => ({ id })))
      .mockImplementationOnce(async () => []);
    const result = await runJob();

    expect(mockDeleteImages.mock.calls[1]?.[0]).toEqual([1]);
    expect(result).toMatchObject({ deletedWithoutRetraction: 0, heldAtDelete: 1 });
  });
});
