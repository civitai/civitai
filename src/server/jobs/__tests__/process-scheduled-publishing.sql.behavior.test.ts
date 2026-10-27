import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The job's own SQL, run against an in-process Postgres: what a run publishes, and what it engages.

const { mockProcessEngagement } = vi.hoisted(() => ({ mockProcessEngagement: vi.fn() }));

// Hand-listed rather than spread via importOriginal, as in process-scheduled-publishing.rewards.test:
// the real modules build query caches from the db client at import time.
vi.mock('~/server/rewards', () => ({
  firstDailyPostReward: { apply: vi.fn(async () => undefined) },
}));
vi.mock('~/server/rewards/active/firstDailyPost.reward', () => ({
  getFirstDailyPostRewardedIds: vi.fn(async () => new Set<number>()),
}));
vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: mockProcessEngagement } }));
vi.mock('~/server/redis/caches', () => ({
  dataForModelsCache: { refresh: vi.fn() },
  userImageVideoCountCaches: { refresh: vi.fn() },
}));
vi.mock('~/server/services/image.service', () => ({ queueImageSearchIndexUpdate: vi.fn() }));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/services/model-version.service', () => ({
  bustMvCache: vi.fn(async () => undefined),
  publishModelVersionsWithEarlyAccess: vi.fn(),
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/nsfwLevels.service', () => ({
  updateComicNsfwLevels: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/comics/chapter-publish.service', () => ({
  markComicProjectsChapterPublished: vi.fn(),
}));
vi.mock('~/server/services/article-schedule.service', () => ({
  publishDueScheduledArticles: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-scan/submit', () => ({ scanEntitiesInBackground: vi.fn() }));
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: async () => [new Date(0), vi.fn()] as const,
}));

const { processScheduledPublishing } = await import('~/server/jobs/process-scheduled-publishing');
const runJob = () => (processScheduledPublishing as unknown as () => Promise<void>)();

const pg = { db: null as unknown as PGlite };
const OWNER = 7;
const PAST = new Date(Date.now() - 60 * 60_000);

// Runs inside the job's transaction before its first statement: a write landing between the
// job's selects and its UPDATEs.
let beforeTx: (() => Promise<unknown>) | undefined;
// Every statement the job ran inside its transaction, with the rows it returned.
const txLog: { sql: string; rows: Record<string, unknown>[] }[] = [];

beforeAll(async () => {
  pg.db = new PGlite();
  await pg.db.exec(`
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL,
      "publishedAt" timestamp(3), meta jsonb, "lastVersionAt" timestamp(3)
    );
    CREATE TABLE "ModelVersion" (
      id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL,
      "publishedAt" timestamp(3), availability text
    );
    CREATE TABLE "ModelFile" (id serial PRIMARY KEY, "modelVersionId" int NOT NULL);
    CREATE TABLE "PaidAccess" (
      "entityType" text, "entityId" int, "timeframeDays" int, "endsAt" timestamp(3)
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int,
      "publishedAt" timestamp(3), "createdAt" timestamp(3) NOT NULL DEFAULT now(),
      metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "User" (id int PRIMARY KEY, username text);
    CREATE TABLE "ComicProject" (id int PRIMARY KEY, "userId" int, name text);
    CREATE TABLE "ComicChapter" (
      "projectId" int, position int, status text, "publishedAt" timestamp(3), name text
    );
  `);
  const raw = pgliteRaw(pg.db);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) => {
    await pg.db.exec('BEGIN');
    try {
      await beforeTx?.();
      const logged =
        (run: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) =>
        async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const result = await run(strings, ...values);
          txLog.push({
            sql: strings.join('?'),
            rows: Array.isArray(result) ? (result as Record<string, unknown>[]) : [],
          });
          return result;
        };
      const result = await fn({
        $queryRaw: logged(raw.queryRaw),
        $executeRaw: logged(raw.executeRaw),
      });
      await pg.db.exec('COMMIT');
      return result;
    } catch (e) {
      await pg.db.exec('ROLLBACK');
      throw e;
    }
  }) as never);
  dbMock.dbWrite.image.findMany.mockResolvedValue([]);
});

afterAll(async () => {
  await pg.db?.close();
});

beforeEach(async () => {
  mockProcessEngagement.mockReset();
  beforeTx = undefined;
  txLog.length = 0;
  await pg.db.exec(`TRUNCATE "Model", "ModelVersion", "ModelFile", "Post"`);
});

/** A Scheduled model, its Scheduled version and that version's scheduled post, all past due. */
async function scheduled({ withFile }: { withFile: boolean }) {
  await pg.db.query(`INSERT INTO "Model" VALUES (1, $1, 'Scheduled', $2, NULL, NULL)`, [
    OWNER,
    PAST,
  ]);
  await pg.db.query(`INSERT INTO "ModelVersion" VALUES (10, 1, 'Scheduled', $1, 'Private')`, [
    PAST,
  ]);
  await pg.db.query(`INSERT INTO "Post" (id, "userId", "modelVersionId") VALUES (100, $1, 10)`, [
    OWNER,
  ]);
  if (withFile) await addFile();
}
const addFile = () => pg.db.query(`INSERT INTO "ModelFile" ("modelVersionId") VALUES (10)`);

async function state() {
  const [model] = (await pg.db.query<{ status: string }>(`SELECT status FROM "Model" WHERE id = 1`))
    .rows;
  const [version] = (
    await pg.db.query<{ status: string }>(`SELECT status FROM "ModelVersion" WHERE id = 10`)
  ).rows;
  const [post] = (
    await pg.db.query<{ publishedAt: Date | null }>(
      `SELECT "publishedAt" FROM "Post" WHERE id = 100`
    )
  ).rows;
  return { model: model.status, version: version.status, postLive: post.publishedAt !== null };
}

const engaged = (entityType: string) =>
  mockProcessEngagement.mock.calls
    .filter(([e]) => e.entityType === entityType)
    .map(([e]) => e.entityId);

describe('processScheduledPublishing :: a version still waiting on its files', () => {
  // Scheduling ahead of the upload is allowed, and the version waits for a file; its posts and its
  // model wait with it rather than going live around a version nobody can download.
  it('publishes neither the version, its posts nor its model', async () => {
    await scheduled({ withFile: false });
    await runJob();
    expect(await state()).toEqual({ model: 'Scheduled', version: 'Scheduled', postLive: false });
    expect(mockProcessEngagement).not.toHaveBeenCalled();
  });

  it('publishes all three together once the file lands', async () => {
    await scheduled({ withFile: false });
    await runJob();
    await addFile();
    await runJob();
    expect(await state()).toEqual({ model: 'Published', version: 'Published', postLive: true });
  });

  // The file can land between the version select, which then skips the version, and the post select.
  it('does not publish a post ahead of a version its run skipped', async () => {
    await scheduled({ withFile: false });
    const raw = pgliteRaw(pg.db);
    dbMock.dbWrite.$queryRaw.mockImplementation((async (...args: unknown[]) => {
      const [strings] = args as [TemplateStringsArray];
      const rows = await raw.queryRaw(...(args as [TemplateStringsArray]));
      if (strings.join('').includes("'hasEarlyAccess'")) await addFile();
      return rows;
    }) as never);
    try {
      await runJob();
    } finally {
      dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
    }
    expect(await state()).toEqual({ model: 'Scheduled', version: 'Scheduled', postLive: false });
  });
});

describe('processScheduledPublishing :: engagements', () => {
  it('engages the model and the version it published', async () => {
    await scheduled({ withFile: true });
    await runJob();
    expect(engaged('model')).toEqual([1]);
    expect(engaged('modelVersion')).toEqual([10]);
  });

  // A takedown landing after the selects: the UPDATEs re-check the status and skip the rows, and
  // nothing that did not publish may score as published.
  it('engages neither when a takedown lands after the selects', async () => {
    await scheduled({ withFile: true });
    beforeTx = () =>
      pg.db.exec(`
        UPDATE "Model" SET status = 'UnpublishedViolation' WHERE id = 1;
        UPDATE "ModelVersion" SET status = 'UnpublishedViolation' WHERE id = 10;
      `);
    await runJob();
    expect(await state()).toEqual({
      model: 'UnpublishedViolation',
      version: 'UnpublishedViolation',
      postLive: false,
    });
    expect(engaged('model')).toEqual([]);
    expect(engaged('modelVersion')).toEqual([]);
  });
});

describe('processScheduledPublishing :: a takedown after the selects', () => {
  // The model alone: its version stays Scheduled. A Published sibling would satisfy the model's own
  // has-a-Published-version check, so only the status re-check keeps it down.
  it('publishes nothing under a model taken down after the selects', async () => {
    await scheduled({ withFile: true });
    await pg.db.query(`INSERT INTO "ModelVersion" VALUES (11, 1, 'Published', $1, 'Public')`, [
      PAST,
    ]);
    beforeTx = () => pg.db.exec(`UPDATE "Model" SET status = 'UnpublishedViolation' WHERE id = 1`);
    await runJob();
    expect(await state()).toEqual({
      model: 'UnpublishedViolation',
      version: 'Scheduled',
      postLive: false,
    });
    expect(mockProcessEngagement).not.toHaveBeenCalled();
  });
});

describe('processScheduledPublishing :: one version publishes, another waits', () => {
  it("keeps the waiting version's post back, and publishes it with its version later", async () => {
    await scheduled({ withFile: false });
    await pg.db.query(`INSERT INTO "ModelVersion" VALUES (12, 1, 'Scheduled', $1, 'Private')`, [
      PAST,
    ]);
    await pg.db.query(`INSERT INTO "ModelFile" ("modelVersionId") VALUES (12)`);
    await runJob();
    expect(await state()).toEqual({ model: 'Published', version: 'Scheduled', postLive: false });
    await addFile();
    await runJob();
    expect(await state()).toEqual({ model: 'Published', version: 'Published', postLive: true });
  });
});

describe('processScheduledPublishing :: lock order', () => {
  // The order the model takedown and publish paths take rows in: a model, then its versions. Rows
  // are inserted in descending id order so an unordered lock would come back unsorted.
  it('locks every model, then every version, each in ascending id, before any other write', async () => {
    for (const modelId of [3, 2]) {
      await pg.db.query(`INSERT INTO "Model" VALUES ($1, $2, 'Scheduled', $3, NULL, NULL)`, [
        modelId,
        OWNER,
        PAST,
      ]);
      await pg.db.query(`INSERT INTO "ModelVersion" VALUES ($1, $2, 'Scheduled', $3, 'Private')`, [
        modelId * 10,
        modelId,
        PAST,
      ]);
      await pg.db.query(`INSERT INTO "ModelFile" ("modelVersionId") VALUES ($1)`, [modelId * 10]);
    }
    await runJob();

    const locking = txLog.filter(({ sql }) => /FOR NO KEY UPDATE|UPDATE "/.test(sql));
    const ids = (i: number) => locking[i]?.rows.map(({ id }) => id);
    expect(locking[0]?.sql).toMatch(/FROM "Model"[\s\S]*FOR NO KEY UPDATE/);
    expect(ids(0)).toEqual([2, 3]);
    expect(locking[1]?.sql).toMatch(/FROM "ModelVersion"[\s\S]*FOR NO KEY UPDATE/);
    expect(ids(1)).toEqual([20, 30]);
  });
});
