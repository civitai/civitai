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
//   3. AiNotVerified and vanished rows are still swept out of the queue;
//   4. a non-prod database is never mass-deleted;
//   5. an image under a pending appeal is held until the appeal is resolved — and excluded from
//      the batch rather than filtered out of it, so held rows can't sit at the head of the
//      oldest-first queue and starve deletion for everyone else;
//   6. an image flagged for CSAM review is held until the flag is resolved.

const DAY = 24 * 60 * 60 * 1000;
const EXPIRED = new Date(Date.now() - 8 * DAY); // past BLOCKED_IMAGE_RETENTION_DAYS (7)
const RECENT = new Date(Date.now() - 1 * DAY); // inside the retention window

const PLAIN_USER = 1;

const QUEUE = [
  { entityId: 1, createdAt: EXPIRED }, // expired block -> delete
  { entityId: 2, createdAt: RECENT }, // recent block on an ancient upload -> wait
  { entityId: 3, createdAt: EXPIRED }, // AiNotVerified -> swept, never deleted
  { entityId: 4, createdAt: EXPIRED }, // no longer Blocked -> swept, never deleted
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
type FixtureImage = {
  id: number;
  userId: number;
  blockedFor: string;
  ingestion?: string;
  nsfwLevel?: number;
};
// The Image SELECT only ever returns still-Blocked rows; id 4 is absent by construction.
const IMAGES: FixtureImage[] = [
  { id: 1, userId: PLAIN_USER, blockedFor: 'CSAM' },
  { id: 2, userId: PLAIN_USER, blockedFor: 'CSAM' },
  { id: 3, userId: PLAIN_USER, blockedFor: 'AiNotVerified' },
  { id: 7, userId: PLAIN_USER, blockedFor: 'moderated' },
  { id: 8, userId: PLAIN_USER, blockedFor: 'moderated' },
];
// Added by the test that needs it.
const extraImages: FixtureImage[] = [];
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
  appealedIds,
  csamFlaggedIds,
  csamBlockedIds,
  withoutModActivity,
  goneIds,
} = vi.hoisted(() => {
  const execLog: { sql: string; values: unknown[] }[] = [];
  const sqlLog: string[] = [];
  const queueWhereLog: any[] = [];
  const appealedIds: number[] = [];
  const csamFlaggedIds: number[] = [];
  const csamBlockedIds: number[] = [];
  // Images whose block has no moderator takedown on record, so they take the non-retracting call.
  const withoutModActivity: number[] = [];
  // Images deleted by someone else between the batch read and this job's delete.
  const goneIds: number[] = [];
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
  // Postgres's cap on one statement's bind variables. A bound array counts once.
  const MAX_BIND_VARIABLES = 32767;
  const tooManyBindVariables = (n: number) =>
    new Error(
      `too many bind variables in prepared statement, expected maximum of ${MAX_BIND_VARIABLES}, received ${n}`
    );
  // Stand in for the DB actually applying the filters.
  const queueRows = (
    where: any,
    { limit, oldestFirst }: { limit?: number; oldestFirst?: boolean } = {}
  ) => {
    const excluded: number[] = where?.entityId?.notIn ?? [];
    const only: number[] | undefined = where?.entityId?.in;
    const before: Date | undefined = where?.createdAt?.lte;
    const rows = [...QUEUE, ...extraQueue].filter(
      (q) =>
        where?.type === 'BlockedImageDelete' &&
        where?.entityType === 'Image' &&
        !excluded.includes(q.entityId) &&
        (!only || only.includes(q.entityId)) &&
        (!before || q.createdAt <= before)
    );
    if (oldestFirst) rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return limit === undefined ? rows : rows.slice(0, limit);
  };
  // A raw read of "JobQueue", recorded in `queueWhereLog` in the shape of a Prisma `where`. Each
  // filter is read off the statement's own text and the value bound at that spot.
  const queueRead = (sql: string, values: unknown[]) => {
    const bound = (pattern: string) => {
      const at = sql.indexOf(pattern);
      if (at < 0) return undefined;
      return values[sql.slice(0, at + pattern.length).split('?').length - 2];
    };
    const only = bound('AND EXISTS (SELECT 1 FROM unnest(?');
    const excluded = bound('NOT EXISTS (SELECT 1 FROM unnest(?');
    const before = bound('"createdAt" <= ?');
    const where = {
      type: bound('type = ?'),
      entityType: bound('"entityType" = ?'),
      ...(only || excluded ? { entityId: only ? { in: only } : { notIn: excluded } } : {}),
      ...(before ? { createdAt: { lte: before } } : {}),
    };
    queueWhereLog.push(where);
    const limit = bound('LIMIT ?');
    return queueRows(where, {
      limit: limit === undefined ? undefined : Number(limit),
      oldestFirst: /ORDER BY j\."createdAt" ASC/.test(sql),
    });
  };
  const queryRaw = async (first: TemplateStringsArray | SqlLike, ...rawValues: unknown[]) => {
    const { sql, values } = isSql(first)
      ? flatten(first.strings, first.values)
      : flatten(first, rawValues);
    if (values.length > MAX_BIND_VARIABLES) throw tooManyBindVariables(values.length);
    sqlLog.push(sql);
    // The job's two queue reads; its backlog count reads "JobQueue" too, and falls through.
    if (sql.includes('FROM "JobQueue" j')) return queueRead(sql, values);
    // Answers with whichever review flags the query actually names, so dropping one from the
    // SQL is what stops that population being held.
    const reviewFlags = sql.match(/"needsReview" IN \(([^)]*)\)/);
    if (reviewFlags) {
      const named = [...reviewFlags[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      const blocks = sql.includes(`"blockedFor" = 'CSAM'`);
      return [
        ...appealedIds.map((id) => ({ id, needsReview: 'appeal', blockedFor: null })),
        ...csamFlaggedIds.map((id) => ({ id, needsReview: 'csam', blockedFor: null })),
        ...csamBlockedIds.map((id) => ({ id, needsReview: null, blockedFor: 'CSAM' })),
      ].filter((r) => (r.needsReview ? named.includes(r.needsReview) : blocks));
    }
    // The moderator-activity lookup that gates blob retraction. Routed before the catch-all
    // below, which would otherwise answer it with Image rows.
    if (sql.includes('FROM "ModActivity"')) {
      const ids = (values[0] as number[]) ?? [];
      const extraActivity = extraQueue.map((q) => ({
        entityId: q.entityId,
        lastActedAt: new Date(q.createdAt.getTime() + 1000),
      }));
      return [...MOD_ACTIVITY, ...extraActivity].filter(
        (m) => ids.includes(m.entityId) && !withoutModActivity.includes(m.entityId)
      );
    }
    // The existence check on images the delete did not return.
    if (sql.includes('SELECT id FROM "Image" WHERE id = ANY')) {
      const ids = (values.find(Array.isArray) as number[]) ?? [];
      return allImages()
        .filter((i) => ids.includes(i.id) && !goneIds.includes(i.id))
        .map((i) => ({ id: i.id }));
    }
    // The batch SELECT, scoped to whatever ids survived the queue exclusion. It reads Blocked rows only.
    const ids = (values.find(Array.isArray) as number[]) ?? [];
    return allImages().filter(
      (i) => ids.includes(i.id) && (i.ingestion ?? 'Blocked') === 'Blocked'
    );
  };
  return {
    execLog,
    sqlLog,
    queueWhereLog,
    appealedIds,
    csamFlaggedIds,
    csamBlockedIds,
    withoutModActivity,
    goneIds,
    mockEnv,
    mockDbRead: {
      jobQueue: {
        // The job reads its queue with raw SQL now. Kept so a return to Prisma's `in`/`notIn`
        // fails here the way it fails in Postgres: one bind variable per listed id.
        findMany: vi.fn(async ({ where }: any) => {
          const listed = (where?.entityId?.notIn?.length ?? 0) + (where?.entityId?.in?.length ?? 0);
          if (listed > MAX_BIND_VARIABLES) throw tooManyBindVariables(listed);
          queueWhereLog.push(where);
          return queueRows(where);
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
const { mockPersistDeletedTakedowns, mockReserve, mockSettle } = vi.hoisted(() => ({
  mockPersistDeletedTakedowns: vi.fn(async (_rows: { id: number }[], _opts?: unknown) => ({
    sent: 0,
    queued: 0,
    skipped: 0,
    unqueued: [] as number[],
  })),
  mockReserve: vi.fn(async (_rows: { id: number; url?: string | null }[]) => 'reservation'),
  mockSettle: vi.fn(async (_ids: number[], _reservation: string) => undefined),
}));
vi.mock('~/server/services/cdn-access.service', () => ({
  persistDeletedTakedowns: mockPersistDeletedTakedowns,
  reserveTakedownRetractions: mockReserve,
  settleTakedownReservations: mockSettle,
}));
vi.mock('~/env/other', () => ({ isProd: true }));
vi.mock('~/env/server', () => ({ env: mockEnv }));

import { purgeHoldGuard, removeBlockedImages } from '~/server/jobs/image-ingestion';

const TRAINING_ENV = {
  APPEAL_TRAINING_B2_BUCKET: 'training',
  APPEAL_TRAINING_B2_ACCESS_KEY: 'a',
  APPEAL_TRAINING_B2_SECRET_KEY: 's',
  S3_IMAGE_B2_ENDPOINT: 'https://b2.example',
  S3_IMAGE_B2_ACCESS_KEY: 'ia',
  S3_IMAGE_B2_SECRET_KEY: 'is',
  APPEAL_OWNER_HASH_KEY: 'o',
};

// The default fixture with image 7 under appeal: 7 leaves the batch, 2 is inside retention, 3 and 4
// are stale, and 1 and 8 are deleted as takedowns.
const EXPECTED_SUMMARY = {
  name: 'remove-blocked-images',
  deleted: 2,
  heldAtDelete: 0,
  retracted: 2,
  deletedWithoutRetraction: 0,
  staleRemoved: 2,
  waitingForRetention: 1,
  appealHeld: 1,
  csamReviewHeld: 0,
};
// Every queued image held, so the batch is empty.
const EXPECTED_QUIET_SUMMARY = {
  name: 'remove-blocked-images',
  processed: 0,
  appealHeld: 6,
};

const ctx = {} as Parameters<typeof removeBlockedImages.run>[0];
async function runJob() {
  return (await removeBlockedImages.run(ctx).result) as Partial<{
    deleted: number;
    heldAtDelete: number;
    staleRemoved: number;
    waitingForRetention: number;
    appealHeld: number;
    csamReviewHeld: number;
    processed: number;
    retractionDeferred: number;
    skipped: string;
  }>;
}

function deletedIds() {
  return (mockDeleteImages.mock.calls[0]?.[0] as number[] | undefined) ?? [];
}
/** The options object this job hands `deleteImages` — the retraction intent lives here. */
function deleteOptions() {
  return mockDeleteImages.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
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
function batchWhere() {
  // The last queue read is the batch fetch.
  return queueWhereLog[queueWhereLog.length - 1];
}

beforeEach(() => {
  execLog.length = 0;
  sqlLog.length = 0;
  queueWhereLog.length = 0;
  appealedIds.length = 0;
  csamFlaggedIds.length = 0;
  csamBlockedIds.length = 0;
  withoutModActivity.length = 0;
  goneIds.length = 0;
  extraImages.length = 0;
  extraQueue.length = 0;
  mockEnv.DATABASE_IS_PROD = true;
  for (const key of Object.keys(TRAINING_ENV)) delete (mockEnv as Record<string, unknown>)[key];
  mockDbRead.jobQueue.findMany.mockClear();
  mockDbRead.$queryRaw.mockClear();
  mockDbWrite.$queryRaw.mockClear();
  mockDbWrite.$executeRaw.mockClear();
  mockDeleteImages.mockClear();
  mockLogToAxiom.mockClear();
  mockPersistDeletedTakedowns.mockClear();
  mockReserve.mockReset().mockResolvedValue('reservation');
  mockSettle.mockClear();
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
    expect(deleteOptions()).toMatchObject({ retractPublicBlobs: true, moderatorDelete: true });
    // And persists exactly the rows it deleted, after deleting them.
    expect(mockPersistDeletedTakedowns).toHaveBeenLastCalledWith(
      await mockDeleteImages.mock.results.at(-1)?.value,
      { reservation: 'reservation' }
    );
    expect(mockPersistDeletedTakedowns.mock.invocationCallOrder.at(-1)).toBeGreaterThan(
      mockDeleteImages.mock.invocationCallOrder.at(-1) as number
    );
  });

  // `updatePosts` defaults on in `deleteImages`: the takedown's posts must still be recounted, so
  // the job must not turn it off while asking for retraction.
  it('leaves post updating on while doing so', async () => {
    await runJob();

    expect(deleteOptions()).toBeDefined();
    expect(deleteOptions()?.updatePosts).not.toBe(false);
  });

  // What the post-deploy check reads: the job runner itself logs only that a run succeeded.
  const summaryLog = () =>
    mockLogToAxiom.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((a) => a.message === 'finished');

  it("logs the run's counts", async () => {
    appealedIds.push(7);
    await runJob();

    expect(summaryLog()).toMatchObject(EXPECTED_SUMMARY);
    expect(Number.isFinite(summaryLog()?.durationMs)).toBe(true);
  });

  it("logs a quiet run's counts", async () => {
    appealedIds.push(1, 2, 3, 4, 7, 8);
    await runJob();

    expect(summaryLog()).toMatchObject(EXPECTED_QUIET_SUMMARY);
  });

  // Every run failed once the held Blocked images passed Postgres's 32767 bind variables: the queue
  // read listed the held ids one variable each. It now binds them as one array.
  it('still runs when more ids are held than one statement can bind one by one', async () => {
    const HELD_COUNT = 40_000;
    for (let i = 0; i < HELD_COUNT; i++) appealedIds.push(100_000 + i);
    const result = await runJob();

    expect(result.skipped).toBeUndefined();
    expect(result.appealHeld).toBe(HELD_COUNT);
    expect(deletedIds()).toEqual(expect.arrayContaining([1, 8]));
    expect(batchWhere().entityId.notIn).toHaveLength(HELD_COUNT);
  });

  it('does not constrain the batch when nothing is held', async () => {
    await runJob();

    expect(batchWhere()?.entityId).toEqual({ notIn: [] });
    expect(deletedIds()).toContain(1);
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
    // Excluded from the batch, so held rows cannot starve the window.
    expect(batchWhere()?.entityId?.notIn).toEqual([7]);
    expect(batchWhere()).toMatchObject({ type: 'BlockedImageDelete', entityType: 'Image' });
  });

  it('deletes the image once the appeal is no longer pending', async () => {
    const result = await runJob();

    expect(deletedIds()).toContain(7);
    expect(result.appealHeld).toBe(0);
  });

  it('holds a blocked image flagged for review', async () => {
    csamFlaggedIds.push(8);
    const result = await runJob();

    expect(deletedIds()).not.toContain(8);
    expect(result.csamReviewHeld).toBe(1);
    expect(queuePruneIds()).not.toContain(8);
    expect(batchWhere()?.entityId?.notIn).toEqual([8]);
    // Neither population stands in for the other.
    expect(result.appealHeld).toBe(0);
  });

  it('holds a CSAM-blocked image', async () => {
    extraImages.push({ id: 9, userId: 999, blockedFor: 'CSAM' });
    extraQueue.push({ entityId: 9, createdAt: EXPIRED });
    csamBlockedIds.push(9);
    const result = await runJob();

    expect(deletedIds()).not.toContain(9);
    expect(queuePruneIds()).not.toContain(9);
    expect(result.csamBlockHeld).toBe(1);
    expect(batchWhere()?.entityId?.notIn).toEqual([9]);
    expect(result.csamReviewHeld).toBe(0);
  });

  // Neither mock evaluates these, so they are pinned here. Dropping the ingestion predicate puts
  // every flagged image on the site, blocked or not, into the batch's notIn list; reading from
  // the replica misses a flag set inside the lag window.
  it('reads the review hold from the primary, over the shared hold selection', async () => {
    await runJob();

    const isHoldSql = (s: string) => s.includes('"needsReview" IN');
    const sqlOf = (calls: unknown[][]) => calls.map((c) => sqlText(c[0]));
    const onWrite = sqlOf(mockDbWrite.$queryRaw.mock.calls).filter(isHoldSql);
    const onRead = sqlOf(mockDbRead.$queryRaw.mock.calls).filter(isHoldSql);

    expect(onRead).toEqual([]);
    expect(onWrite).toHaveLength(1);
    expect(onWrite[0]).toMatch(
      /WHERE \("needsReview" IN \('appeal', 'csam'\) OR "blockedFor" = 'CSAM'\)\s+AND ingestion = 'Blocked'::"ImageIngestionStatus"\s+UNION ALL\s+SELECT id, "needsReview", "blockedFor" FROM "Image"\s+WHERE \("needsReview" IN \('appeal', 'csam'\) OR "blockedFor" = 'CSAM'\)\s+AND ingestion = 'Error'::"ImageIngestionStatus" AND \(\s*"Image"\."ingestion" = \?::"ImageIngestionStatus"\s+OR "Image"\."nsfwLevel" = \?\s+OR "Image"\."blockedFor" IS NOT NULL\s*\)\s*$/
    );
  });

  it('holds appealed and CSAM-flagged images side by side', async () => {
    appealedIds.push(7);
    csamFlaggedIds.push(8);
    const result = await runJob();

    expect(deletedIds()).not.toContain(7);
    expect(deletedIds()).not.toContain(8);
    expect(result).toMatchObject({ appealHeld: 1, csamReviewHeld: 1 });
    expect(batchWhere()?.entityId?.notIn).toEqual(expect.arrayContaining([7, 8]));
  });

  it('deletes the image once the CSAM flag is resolved', async () => {
    const result = await runJob();

    expect(deletedIds()).toContain(8);
    expect(result.csamReviewHeld).toBe(0);
  });

  // The guard's own semantics are pinned against Postgres in
  // remove-blocked-images-guard.behavior.test.ts; this pins that the job hands it over.
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
      (c) => (c[1] as { onlyWhere?: { sql: string } } | undefined)?.onlyWhere
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

describe('remove-blocked-images retraction load', () => {
  // 60 more moderator takedowns past retention, so the takedowns span several chunks.
  const addTakedowns = () => {
    for (let id = 100; id < 160; id++) {
      extraImages.push({ id, userId: PLAIN_USER, blockedFor: 'moderated' });
      extraQueue.push({ entityId: id, createdAt: EXPIRED });
    }
  };
  const retractingCalls = () =>
    mockDeleteImages.mock.calls.filter(
      (c) => (c[1] as { retractPublicBlobs?: boolean } | undefined)?.retractPublicBlobs === true
    );

  it('stops starting retracting deletes after a 429 and leaves the rest queued', async () => {
    addTakedowns();
    mockDeleteImages.mockImplementationOnce(async (ids: number[]) =>
      ids.map((id) => ({ id, url: `key-${id}`, retraction: 'busy' as const }))
    );
    const result = await runJob();

    expect(retractingCalls()).toHaveLength(1);
    const started = retractingCalls()[0][0] as number[];
    expect(started.length).toBeGreaterThan(0);
    expect(started.length).toBeLessThan(60);
    const deferred = [...Array(60).keys()]
      .map((i) => 100 + i)
      .filter((id) => !started.includes(id));
    expect(deferred.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ retractionDeferred: deferred.length });
    for (const id of deferred) expect(queuePruneIds()).not.toContain(id);
    for (const id of started) expect(queuePruneIds()).toContain(id);
    // Deferred, not held: they were never handed to the delete.
    expect(result).toMatchObject({ heldAtDelete: 0 });
  });

  it('keeps going while the service answers, in chunks', async () => {
    addTakedowns();
    const result = await runJob();

    const chunks = retractingCalls().map((c) => c[0] as number[]);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().sort((a, b) => a - b)).toEqual(
      [1, 7, 8, ...[...Array(60).keys()].map((i) => 100 + i)].sort((a, b) => a - b)
    );
    expect(result).toMatchObject({ retractionDeferred: 0 });
  });

  it('stops starting retracting deletes once its time budget is spent', async () => {
    addTakedowns();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      mockDeleteImages.mockImplementationOnce(async (ids: number[]) => {
        vi.setSystemTime(Date.now() + 9 * 60 * 1000);
        return ids.map((id) => ({ id }));
      });
      const result = await runJob();

      expect(retractingCalls()).toHaveLength(1);
      expect(result.retractionDeferred).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues each chunk's retractions before deleting it, so a crash after the delete leaves them", async () => {
    addTakedowns();
    mockPersistDeletedTakedowns.mockRejectedValueOnce(new Error('process died'));
    await expect(runJob()).rejects.toThrow('process died');

    expect(retractingCalls()).toHaveLength(1);
    const chunkIds = retractingCalls()[0][0] as number[];
    expect(mockReserve).toHaveBeenCalledTimes(1);
    expect(mockReserve.mock.calls[0][0].map((r) => r.id)).toEqual(chunkIds);
    expect(mockReserve.mock.invocationCallOrder[0]).toBeLessThan(
      mockDeleteImages.mock.invocationCallOrder[0]
    );
    // Nothing settled them, so they stay queued for the retry.
    expect(mockSettle).not.toHaveBeenCalled();
  });

  // Whether the retry was WRITTEN decides it, not the retraction's outcome: a written retry already
  // released the reservation, and an unwritten one leaves the reservation as the only record.
  it('keeps the reservation only where the retry could not be written', async () => {
    addTakedowns();
    mockDeleteImages.mockImplementationOnce(async (ids: number[]) =>
      ids.map((id, i) => ({
        id,
        retraction: i === 0 ? ('unconfirmed' as const) : ('confirmed' as const),
      }))
    );
    mockPersistDeletedTakedowns.mockImplementationOnce(async (rows: { id: number }[]) => ({
      sent: 0,
      queued: 2,
      skipped: 0,
      // The first row's retry was written; the second's (a failed persist) was not.
      unqueued: [rows[1].id],
    }));
    await runJob();

    const chunkIds = retractingCalls()[0][0] as number[];
    expect(mockSettle.mock.calls[0]).toEqual([
      chunkIds.filter((id) => id !== chunkIds[1]),
      'reservation',
    ]);
  });

  it('keeps the reservation of an image deleted by someone else before this delete', async () => {
    addTakedowns();
    goneIds.push(8);
    mockDeleteImages.mockImplementationOnce(async (ids: number[]) =>
      ids.filter((id) => id !== 8).map((id) => ({ id, retraction: 'confirmed' as const }))
    );
    await runJob();

    const chunkIds = retractingCalls()[0][0] as number[];
    expect(chunkIds).toContain(8);
    expect(mockSettle.mock.calls[0][0]).toEqual(chunkIds.filter((id) => id !== 8));
  });

  it('releases the reservation of an image the delete kept, so a held image gets no retraction', async () => {
    addTakedowns();
    mockDeleteImages.mockImplementationOnce(async (ids: number[]) =>
      ids.filter((id) => id !== 7).map((id) => ({ id, retraction: 'confirmed' as const }))
    );
    await runJob();

    const chunkIds = retractingCalls()[0][0] as number[];
    expect(chunkIds).toContain(7);
    expect(mockSettle.mock.calls[0][0]).toContain(7);
    expect(mockSettle.mock.calls[0][0]).toEqual(chunkIds);
  });

  it('deletes no takedown when their retractions cannot be queued', async () => {
    addTakedowns();
    mockReserve.mockRejectedValue(new Error('invalid input value for enum'));
    const result = await runJob();

    expect(retractingCalls()).toHaveLength(0);
    expect(result).toMatchObject({ retractionDeferred: 63 });
    for (const id of [1, 7, 8, 100, 159]) expect(queuePruneIds()).not.toContain(id);
  });

  it('stops starting retracting deletes after a timeout trips the run gate', async () => {
    addTakedowns();
    mockDeleteImages.mockImplementationOnce(async (ids: number[], opts) => {
      (opts as { retractionGate: { busy: boolean } }).retractionGate.busy = true;
      return ids.map((id) => ({ id, retraction: 'unconfirmed' as const }));
    });
    const result = await runJob();

    expect(retractingCalls()).toHaveLength(1);
    expect(result.retractionDeferred).toBeGreaterThan(0);
  });

  it('deletes the takedowns that have waited longest first', async () => {
    // Queued in the opposite order to the image rows the job reads.
    for (let i = 0; i < 40; i++) {
      extraImages.push({ id: 200 + i, userId: PLAIN_USER, blockedFor: 'moderated' });
      extraQueue.push({
        entityId: 200 + i,
        createdAt: new Date(EXPIRED.getTime() - (40 - i) * DAY),
      });
    }
    await runJob();

    const first = retractingCalls()[0][0] as number[];
    expect([...first].sort((a, b) => a - b)).toEqual([...Array(25).keys()].map((i) => 200 + i));
  });
});
