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
//   3. media of a user under a legal hold is held — and excluded from the batch
//      rather than filtered out of it, so held rows can't sit at the head of the
//      oldest-first queue and starve deletion for everyone else;
//   4. the hold has no age ceiling, and a failed hold lookup deletes nothing (which
//      users the hold covers is pinned against Postgres in the hold-guard behavior test);
//   5. AiNotVerified and vanished rows are still swept out of the queue;
//   6. a non-prod database is never mass-deleted;
//   7. an image under a pending appeal is held until the appeal is resolved;
//   8. an image flagged for CSAM review is held until the flag is resolved;
//   9. an image whose owner is under a hold marker is held.

const DAY = 24 * 60 * 60 * 1000;
const EXPIRED = new Date(Date.now() - 8 * DAY); // past BLOCKED_IMAGE_RETENTION_DAYS (7)
const RECENT = new Date(Date.now() - 1 * DAY); // inside the retention window

const PLAIN_USER = 1;
const HELD_USER = 999; // under a legal hold
const LONG_HELD_USER = 888; // under a legal hold from a report filed long ago
const PLACEHOLDER_OWNER = -1;

const QUEUE = [
  { entityId: 1, createdAt: EXPIRED }, // expired block -> delete
  { entityId: 2, createdAt: RECENT }, // recent block on an ancient upload -> wait
  { entityId: 3, createdAt: EXPIRED }, // AiNotVerified -> swept, never deleted
  { entityId: 4, createdAt: EXPIRED }, // no longer Blocked -> swept, never deleted
  { entityId: 5, createdAt: EXPIRED }, // legal hold -> excluded from the batch
  { entityId: 6, createdAt: EXPIRED }, // legal hold from an old report -> excluded all the same
  { entityId: 7, createdAt: EXPIRED }, // under appeal when a test marks it so -> held
  { entityId: 8, createdAt: EXPIRED }, // flagged for CSAM review when a test marks it so -> held
  { entityId: 10, createdAt: RECENT }, // legal hold, inside retention -> held, not "would skip"
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
  { id: 6, userId: LONG_HELD_USER, blockedFor: 'CSAM' },
  { id: 7, userId: PLAIN_USER, blockedFor: 'moderated' },
  { id: 8, userId: PLAIN_USER, blockedFor: 'moderated' },
  { id: 10, userId: HELD_USER, blockedFor: 'CSAM' },
];
// Added by the test that needs it, so the placeholder owner's image is not in every batch.
const extraImages: { id: number; userId: number; blockedFor: string }[] = [];
const extraQueue: { entityId: number; createdAt: Date }[] = [];
const allImages = () => [...IMAGES, ...extraImages];

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
  holdLookup,
  appealedIds,
  csamFlaggedIds,
  evidenceHeldUserIds,
  accountHeldIds,
  markerView,
  withoutModActivity,
} = vi.hoisted(() => {
  const execLog: { sql: string; values: unknown[] }[] = [];
  const sqlLog: string[] = [];
  const queueWhereLog: any[] = [];
  // Mutable so a test can vary which users are held. Text, as the hold's SQL returns them.
  const heldUsers: { userId: string }[] = [];
  const holdLookup = { error: null as Error | null };
  const appealedIds: number[] = [];
  const csamFlaggedIds: number[] = [];
  // Owners under a hold marker.
  const evidenceHeldUserIds: number[] = [];
  // Blocked images of accounts under any other account hold.
  const accountHeldIds: number[] = [];
  // Whether the database has the hold marker's view.
  const markerView = { present: true };
  // Images whose block has no moderator takedown on record, so they take the non-retracting call.
  const withoutModActivity: number[] = [];
  const mockEnv = {
    IMAGE_SCANNING_MAX_PER_RUN: 100,
    IMAGE_SCANNING_RETRY_DELAY: 5,
    IMAGE_SCANNING_PENDING_TIMEOUT: 30,
    DATABASE_IS_PROD: true,
  };
  // Inlines nested `Prisma.sql` fragments, so a query built from a shared fragment is routed by
  // the text it actually sends.
  type SqlLike = { strings: readonly string[]; values: unknown[] };
  const isSql = (v: unknown): v is SqlLike =>
    !!v && typeof v === 'object' && 'strings' in v && 'values' in v;
  const flatten = (strings: readonly string[], values: unknown[]): SqlLike & { sql: string } => {
    let sql = strings[0];
    const out: unknown[] = [];
    values.forEach((v, i) => {
      if (isSql(v)) {
        const inner = flatten(v.strings, v.values);
        sql += inner.sql;
        out.push(...inner.values);
      } else {
        sql += '?';
        out.push(v);
      }
      sql += strings[i + 1];
    });
    return { sql, strings, values: out };
  };
  const queryRaw = async (first: TemplateStringsArray | SqlLike, ...rawValues: unknown[]) => {
    const { sql, values } = isSql(first)
      ? flatten(first.strings, first.values)
      : flatten(first, rawValues);
    sqlLog.push(sql);
    if (sql.includes('SELECT to_regclass(')) return [{ present: markerView.present }];
    // Routed before the report lookup below: the account hold reads "CsamReport" too.
    if (sql.includes('SELECT c."userId" FROM')) return accountHeldIds.map((id) => ({ id }));
    if (sql.includes('FROM "CsamReport"')) {
      if (holdLookup.error) throw holdLookup.error;
      return heldUsers;
    }
    if (sql.includes('FROM "EvidenceHeldUser"'))
      return evidenceHeldUserIds.map((userId) => ({ userId }));
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
      return allImages()
        .filter((i) => ids.includes(i.userId))
        .map((i) => ({ id: i.id }));
    }
    // The batch SELECT, scoped to whatever ids survived the queue exclusion.
    const ids = (values.find(Array.isArray) as number[]) ?? [];
    return allImages().filter((i) => ids.includes(i.id));
  };
  return {
    execLog,
    sqlLog,
    queueWhereLog,
    heldUsers,
    holdLookup,
    appealedIds,
    csamFlaggedIds,
    evidenceHeldUserIds,
    accountHeldIds,
    markerView,
    withoutModActivity,
    mockEnv,
    mockDbRead: {
      jobQueue: {
        findMany: vi.fn(async ({ where }: any) => {
          queueWhereLog.push(where);
          // Stand in for the DB actually applying the filters.
          const excluded: number[] = where?.entityId?.notIn ?? [];
          const only: number[] | undefined = where?.entityId?.in;
          const before: Date | undefined = where?.createdAt?.lte;
          return [...QUEUE, ...extraQueue].filter(
            (q) =>
              !excluded.includes(q.entityId) &&
              (!only || only.includes(q.entityId)) &&
              (!before || q.createdAt <= before)
          );
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
    // Async like the real logger: the sweep chains `.catch` on it.
    mockLogToAxiom: vi.fn(async (_data: Record<string, unknown>) => undefined),
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
// Hand-listed for the same reason: the takedown sync loads the CDN and edge-url clients, which
// this file's env and logging stubs cannot boot. The job imports only this from it.
const { mockPersistDeletedTakedowns } = vi.hoisted(() => ({
  mockPersistDeletedTakedowns: vi.fn(async (_rows: { id: number }[]) => ({
    sent: 0,
    queued: 0,
    skipped: 0,
  })),
}));
vi.mock('~/server/services/cdn-access.service', () => ({
  persistDeletedTakedowns: mockPersistDeletedTakedowns,
}));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({ env: mockEnv }));

import {
  accountHeldBlockedImagesSql,
  purgeHoldGuard,
  removeBlockedImages,
} from '~/server/jobs/image-ingestion';
import { legalHoldUserIdsSql } from '~/server/utils/legal-hold';

const TRAINING_ENV = {
  APPEAL_TRAINING_B2_BUCKET: 'training',
  APPEAL_TRAINING_B2_ACCESS_KEY: 'a',
  APPEAL_TRAINING_B2_SECRET_KEY: 's',
  S3_IMAGE_B2_ENDPOINT: 'https://b2.example',
  S3_IMAGE_B2_ACCESS_KEY: 'ia',
  S3_IMAGE_B2_SECRET_KEY: 'is',
  APPEAL_OWNER_HASH_KEY: 'o',
};

// The default fixture with image 7's account held and a marker on HELD_USER: 5, 6 and 10 are
// legal-held (5 and 10 marker-held too), 7 leaves the batch, 2 is inside retention, 3 and 4 are
// stale, and 1 and 8 are deleted as takedowns.
const EXPECTED_SUMMARY = {
  name: 'remove-blocked-images',
  deleted: 2,
  heldAtDelete: 0,
  retracted: 2,
  deletedWithoutRetraction: 0,
  staleRemoved: 2,
  waitingForRetention: 1,
  csamHeld: 3,
  appealHeld: 0,
  csamReviewHeld: 0,
  evidenceHeld: 2,
  accountHeld: 1,
};
// Every queued image held one way or another, so the batch is empty.
const EXPECTED_QUIET_SUMMARY = {
  name: 'remove-blocked-images',
  processed: 0,
  csamHeld: 3,
  accountHeld: 6,
};

const ctx = {} as Parameters<typeof removeBlockedImages.run>[0];
async function runJob() {
  return (await removeBlockedImages.run(ctx).result) as Partial<{
    deleted: number;
    heldAtDelete: number;
    staleRemoved: number;
    waitingForRetention: number;
    csamHeld: number;
    appealHeld: number;
    csamReviewHeld: number;
    evidenceHeld: number;
    accountHeld: number;
    processed: number;
    skipped: string;
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
/** A query's text, whether it was called as a tagged template or with a `Prisma.sql` value. */
function sqlText(first: unknown) {
  const strings = (first as { strings?: readonly string[] }).strings ?? (first as string[]);
  return strings.join('?');
}
function wouldSkipLogs() {
  return mockLogToAxiom.mock.calls
    .map((c) => c[0] as Record<string, unknown>)
    .filter((a) => a.message === 'Would skip');
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
  evidenceHeldUserIds.length = 0;
  accountHeldIds.length = 0;
  markerView.present = true;
  withoutModActivity.length = 0;
  extraImages.length = 0;
  extraQueue.length = 0;
  holdLookup.error = null;
  heldUsers.push({ userId: String(HELD_USER) }, { userId: String(LONG_HELD_USER) });
  mockEnv.DATABASE_IS_PROD = true;
  for (const key of Object.keys(TRAINING_ENV)) delete (mockEnv as Record<string, unknown>)[key];
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

  // This job is the moderation flow allowed to ask the image-cache service to retract an
  // image's public copies, not just invalidate them. Every other caller of `deleteImages`
  // (replaced-image reaping, deleted-user cleanup, the moderator bulk endpoint) omits the
  // option and gets today's behaviour. The intent has to be stated here, in words, or it does
  // not travel: `deleteImages` defaults it off at every layer below.
  it('asks for blob retraction, because this is a moderation takedown', async () => {
    await runJob();

    expect(mockDeleteImages).toHaveBeenCalledTimes(1);
    expect(deleteOptions()).toMatchObject({ retractPublicBlobs: true });
    // And persists exactly the rows it deleted, after deleting them.
    expect(mockPersistDeletedTakedowns).toHaveBeenLastCalledWith(
      await mockDeleteImages.mock.results.at(-1)?.value
    );
    expect(mockPersistDeletedTakedowns.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      mockDeleteImages.mock.invocationCallOrder.at(-1) as number
    );
  });

  // The option is the third argument; `updatePosts` is the second and must keep its value.
  // Passing the options object in the wrong position would read as `updatePosts = {…}` —
  // truthy, so nothing visibly breaks, while the retraction silently never happens.
  it('leaves post updating on while doing so', async () => {
    await runJob();

    expect(mockDeleteImages.mock.calls[0]?.[1]).toBe(true);
  });

  it('holds media of a user under a legal hold', async () => {
    const result = await runJob();

    expect(deletedIds()).not.toContain(5);
    expect(result.csamHeld).toBe(3);
    // Held media stays queued so it resumes once the hold lifts — it must not be swept as stale.
    expect(queuePruneIds()).not.toContain(5);
  });

  // Which users the hold covers is pinned against Postgres in the hold-guard behavior test, which runs
  // the same query; this pins that the job runs exactly that query, on the primary.
  it('reads the held users from the shared legal hold, on the primary', async () => {
    await runJob();

    const holdCalls = (calls: unknown[][]) =>
      calls.filter((c) => sqlText(c[0]).includes('FROM "CsamReport"'));
    expect(holdCalls(mockDbRead.$queryRaw.mock.calls)).toEqual([]);
    // The account hold reads "CsamReport" too, from the batch exclusion.
    expect(holdCalls(mockDbWrite.$queryRaw.mock.calls)).toEqual([
      [legalHoldUserIdsSql],
      [accountHeldBlockedImagesSql],
    ]);
  });

  // An id that is not a number names no user, so it is dropped rather than failing every run.
  it('ignores a held user id that is not a number', async () => {
    heldUsers.push({ userId: 'not-a-number' });
    await runJob();

    const heldImageLookup = mockDbRead.$queryRaw.mock.calls.find((c) =>
      sqlText(c[0]).includes('"userId" = ANY')
    );
    expect(heldImageLookup?.[1]).toEqual([PLACEHOLDER_OWNER, HELD_USER, LONG_HELD_USER]);
    expect(deletedIds()).toContain(1);
  });

  it('excludes held media from the batch instead of filtering it afterwards', async () => {
    await runJob();

    // The starvation guard: held ids never enter the 15k window, so they cannot sit at
    // the head of the oldest-first queue and consume it every run.
    expect(batchWhere()?.entityId?.notIn).toEqual(expect.arrayContaining([5, 10]));
    // The batch must stay scoped to this queue type — a widened where would delete
    // unrelated entities.
    expect(batchWhere()).toMatchObject({ type: 'BlockedImageDelete', entityType: 'Image' });
  });

  it('holds however long ago the report was filed', async () => {
    await runJob();

    expect(deletedIds()).not.toContain(6);
    expect(batchWhere()?.entityId?.notIn).toContain(6);
    expect(queuePruneIds()).not.toContain(6);
  });

  it('keeps an image whose owner is under a hold marker', async () => {
    evidenceHeldUserIds.push(PLAIN_USER);
    await runJob();

    expect(deletedIds()).not.toContain(1);
    expect(batchWhere()?.entityId?.notIn).toContain(1);
    expect(queuePruneIds()).not.toContain(1);
    // Read off the primary: a marker written within replica lag must still hold this run.
    expect(
      // The legal-hold lookup passes a `Prisma.sql` object, not a template.
      mockDbWrite.$queryRaw.mock.calls.some(([first]) =>
        ('strings' in first ? first.strings : first).join('?').includes('"EvidenceHeldUser"')
      )
    ).toBe(true);
  });

  it('deletes nothing, and runs nothing that names the marker view, on a database without it', async () => {
    markerView.present = false;
    const result = await runJob();

    expect(result.skipped).toBe('hold-marker-view-missing');
    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(execLog.map((e) => e.sql)).not.toContain('SELECT evidence_hold_purge_unheld()');
    // The existence check passes the name as a value, so any match here is a statement naming it.
    expect(sqlLog.filter((sql) => sql.includes('EvidenceHeldUser'))).toEqual([]);
  });

  // What the post-deploy check reads: the job runner itself logs only that a run succeeded.
  const summaryLog = () =>
    mockLogToAxiom.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((a) => a.message === 'finished');

  it("logs the run's counts", async () => {
    accountHeldIds.push(7);
    evidenceHeldUserIds.push(HELD_USER);
    await runJob();

    expect(summaryLog()).toMatchObject(EXPECTED_SUMMARY);
    expect(Number.isFinite(summaryLog()?.durationMs)).toBe(true);
  });

  it("logs a quiet run's counts", async () => {
    accountHeldIds.push(1, 2, 3, 4, 7, 8);
    await runJob();

    expect(summaryLog()).toMatchObject(EXPECTED_QUIET_SUMMARY);
  });

  it('keeps every Blocked image of an account under any other account hold out of the batch', async () => {
    accountHeldIds.push(1);
    await runJob();

    expect(deletedIds()).not.toContain(1);
    expect(batchWhere()?.entityId?.notIn).toContain(1);
  });

  // A hold that ends by its date writes nothing, so this run is what clears what it kept; the
  // function itself is pinned in remove-blocked-images-hold-guard.behavior.test.ts.
  it('sweeps what ended holds kept', async () => {
    await runJob();

    expect(execLog.map((e) => e.sql)).toContain('SELECT evidence_hold_purge_unheld()');
  });

  // e.g. the function not there yet while the hand-applied migration lags the deploy.
  it('still deletes when the sweep fails', async () => {
    const recordOnly = mockDbWrite.$executeRaw.getMockImplementation()!;
    mockDbWrite.$executeRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (strings.join('?').includes('evidence_hold_purge_unheld'))
          throw new Error('function evidence_hold_purge_unheld() does not exist');
        return recordOnly(strings, ...values);
      }
    );
    try {
      await runJob();
    } finally {
      mockDbWrite.$executeRaw.mockImplementation(recordOnly);
    }

    expect(deletedIds()).toContain(1);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'evidence hold sweep failed' })
    );
  });

  it("holds the placeholder owner's media", async () => {
    heldUsers.length = 0;
    extraImages.push({ id: 9, userId: PLACEHOLDER_OWNER, blockedFor: 'CSAM' });
    extraQueue.push({ entityId: 9, createdAt: EXPIRED });
    await runJob();

    expect(deletedIds()).not.toContain(9);
    expect(batchWhere()?.entityId?.notIn).toEqual([9]);
  });

  it('logs the held images past retention as ones it would otherwise delete', async () => {
    await runJob();

    const skips = wouldSkipLogs();
    expect(skips).toHaveLength(1);
    // 10 is held but still inside retention, so this run would not have deleted it anyway.
    expect(skips[0]).toMatchObject({ reason: 'legal-hold', imageIds: [5, 6], count: 2 });
    // Read from this job's own queue, or another queue's rows could be counted.
    expect(queueWhereLog.find((w) => w?.entityId?.in)).toMatchObject({
      type: 'BlockedImageDelete',
      entityType: 'Image',
    });
  });

  it('deletes nothing when the legal hold cannot be read', async () => {
    holdLookup.error = new Error('connection reset');
    const result = await runJob();

    expect(mockDeleteImages).not.toHaveBeenCalled();
    expect(execLog).toHaveLength(0);
    expect(result).toEqual({ skipped: 'legal-hold-lookup-failed' });
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', error: 'connection reset' })
    );
  });

  it('does not constrain the batch when no user is held', async () => {
    heldUsers.length = 0;
    const result = await runJob();

    expect(batchWhere()?.entityId).toBeUndefined();
    expect(result.csamHeld).toBe(0);
    // id 5 is now an ordinary expired block.
    expect(deletedIds()).toContain(5);
    expect(wouldSkipLogs()).toEqual([]);
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
    const sqlOf = (calls: unknown[][]) => calls.map((c) => sqlText(c[0]));
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
  it('re-checks its holds on the delete', async () => {
    await runJob();

    const onlyWhere = deleteOptions()?.onlyWhere as { sql: string } | undefined;
    expect(onlyWhere?.sql).toBe(purgeHoldGuard({ holdForTrainingCopy: false }).sql);
  });

  it('adds the training-copy hold only when the copy job is configured', async () => {
    Object.assign(mockEnv, TRAINING_ENV);
    await runJob();

    const onlyWhere = deleteOptions()?.onlyWhere as { sql: string } | undefined;
    expect(onlyWhere?.sql).toBe(purgeHoldGuard({ holdForTrainingCopy: true }).sql);
    expect(onlyWhere?.sql).not.toBe(purgeHoldGuard({ holdForTrainingCopy: false }).sql);
  });

  it('guards the non-retracting delete as well as the takedown one', async () => {
    withoutModActivity.push(1);
    await runJob();

    const guards = mockDeleteImages.mock.calls.map(
      (c) => (c[2] as { onlyWhere?: { sql: string } } | undefined)?.onlyWhere
    );
    expect(guards).toHaveLength(2);
    for (const guard of guards) {
      expect(guard?.sql).toBe(purgeHoldGuard({ holdForTrainingCopy: false }).sql);
    }
  });

  it('keeps the queue row of an image a hold kept at delete time', async () => {
    mockDeleteImages.mockImplementationOnce(async (ids: number[]) =>
      ids.filter((id) => id !== 1).map((id) => ({ id }))
    );
    const result = await runJob();

    expect(deletedIds()).toContain(1);
    expect(queuePruneIds()).not.toContain(1);
    expect(queuePruneIds()).toContain(7);
    expect(result).toMatchObject({
      deleted: deletedIds().length - 1,
      heldAtDelete: 1,
      retracted: deletedIds().length - 1,
    });
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
