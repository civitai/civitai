import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/**
 * The rescan endpoint's real SQL against an in-process Postgres: it touches only images posted to
 * a judge-rated collection that never went through the scan, and writes only the scan queue.
 * Ids are invented.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { env } = vi.hoisted(() => ({
  env: {
    WEBHOOK_TOKEN: 'test-token',
    LOGGING: '',
    NEXTAUTH_URL: 'https://example.test',
    TRPC_ORIGINS: [] as string[],
  },
}));
vi.mock('~/env/server', () => ({ env }));
vi.mock('~/server/prom/http-errors', () => ({ instrumentApiResponse: vi.fn() }));

const handler = (await import('~/pages/api/admin/temp/rescan-judge-collection-images')).default;

const JUDGE_COLLECTION = 1;
const PLAIN_COLLECTION = 2;
const JUDGE_POST = 10;
const PLAIN_POST = 20;

// In scope: 101 never scanned, 102 pending manual assignment.
// Out of scope: 103 scanned normally, 104 blocked, 105 pending scan, 106/107 in a plain collection.
const IN_SCOPE = [101, 102];

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "JobQueueType" AS ENUM ('ImageScan', 'CleanUp');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TABLE "Collection" (id int PRIMARY KEY, metadata jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "Post" (id int PRIMARY KEY, "collectionId" int REFERENCES "Collection"(id));
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "postId" int REFERENCES "Post"(id),
      ingestion "ImageIngestionStatus" NOT NULL,
      "scanJobs" jsonb,
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0
    );
    CREATE TABLE "JobQueue" (
      type "JobQueueType" NOT NULL,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      PRIMARY KEY ("entityType", "entityId", type)
    );
  `);
  const raw = pgliteRaw(db);
  dbMock.dbRead.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
});
afterAll(() => db.close());

async function seedBase() {
  await db.exec(`
    DELETE FROM "JobQueue"; DELETE FROM "Image"; DELETE FROM "Post"; DELETE FROM "Collection";
    INSERT INTO "Collection" (id, metadata) VALUES
      (${JUDGE_COLLECTION}, '{"judgesApplyBrowsingLevel": true}'),
      (${PLAIN_COLLECTION}, '{}');
    INSERT INTO "Post" (id, "collectionId") VALUES
      (${JUDGE_POST}, ${JUDGE_COLLECTION}), (${PLAIN_POST}, ${PLAIN_COLLECTION});
    INSERT INTO "Image" (id, "postId", ingestion, "scanJobs", "blockedFor") VALUES
      (101, ${JUDGE_POST}, 'Scanned', NULL, NULL),
      (102, ${JUDGE_POST}, 'PendingManualAssignment', NULL, NULL),
      (103, ${JUDGE_POST}, 'Scanned', '{"x": 1}', NULL),
      (104, ${JUDGE_POST}, 'Blocked', NULL, 'tos'),
      (105, ${JUDGE_POST}, 'Pending', NULL, NULL),
      (106, ${PLAIN_POST}, 'Scanned', NULL, NULL),
      (107, ${PLAIN_POST}, 'PendingManualAssignment', NULL, NULL);
  `);
}

const snapshot = async () =>
  (
    await db.query(
      `SELECT i.id, i.ingestion, i."scanJobs", i."blockedFor", i."nsfwLevel",
        (SELECT count(*)::int FROM "JobQueue" q WHERE q."entityId" = i.id) AS queued
       FROM "Image" i ORDER BY i.id`
    )
  ).rows;

const rescanned = async () =>
  (
    await db.query<{ id: number }>(
      `SELECT i.id FROM "Image" i
       JOIN "JobQueue" q ON q."entityId" = i.id AND q.type = 'ImageScan' AND q."entityType" = 'Image'
       WHERE i.ingestion = 'Rescan' ORDER BY i.id`
    )
  ).rows.map((r) => r.id);

async function call(query: Record<string, string>) {
  let statusCode = 0;
  let body: Record<string, unknown> = {};
  const req = { method: 'POST', query: { token: 'test-token', ...query }, headers: {} } as never;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(payload: Record<string, unknown>) {
      body = payload;
      return res;
    },
    setHeader: () => res,
    end: () => res,
    on: () => res,
  };
  await (handler as (req: unknown, res: unknown) => Promise<unknown>)(req, res);
  return { statusCode, body };
}

beforeEach(async () => {
  vi.clearAllMocks();
  await seedBase();
});

describe('rescan-judge-collection-images', () => {
  it('is a dry run by default: counts each cohort, checks the scope, writes nothing', async () => {
    const before = await snapshot();

    const { statusCode, body } = await call({});

    expect(statusCode).toBe(200);
    expect(body).toEqual({
      dryRun: true,
      cohorts: { neverScanned: 1, pendingManual: 1 },
      controls: { inScope: 'included', outOfScope: 'excluded' },
    });
    expect(await snapshot()).toEqual(before);
  });

  it('queues a rescan for both cohorts and nothing else, leaving the rest of the row alone', async () => {
    const { statusCode, body } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(200);
    expect(body).toMatchObject({ dryRun: false, queued: 2 });
    expect(await rescanned()).toEqual(IN_SCOPE);
    const rows = await snapshot();
    for (const row of rows.filter((r) => !IN_SCOPE.includes(rowId(r))))
      expect(row).toMatchObject({ queued: 0 });
    expect(rows.find((r) => rowId(r) === 104)).toMatchObject({
      ingestion: 'Blocked',
      blockedFor: 'tos',
    });
    expect(rows.filter((r) => IN_SCOPE.includes(rowId(r)))).toEqual([
      { id: 101, ingestion: 'Rescan', scanJobs: null, blockedFor: null, nsfwLevel: 0, queued: 1 },
      { id: 102, ingestion: 'Rescan', scanJobs: null, blockedFor: null, nsfwLevel: 0, queued: 1 },
    ]);
  });

  it('refuses a list with any id outside the scope, and writes nothing', async () => {
    const before = await snapshot();

    const { statusCode, body } = await call({ dryRun: 'false', ids: '101,103,106' });

    expect(statusCode).toBe(400);
    expect(body).toEqual({ error: 'Some ids are outside the scope', refused: 2 });
    expect(await snapshot()).toEqual(before);
  });

  it('queues only the listed ids when all are in scope', async () => {
    const { body } = await call({ dryRun: 'false', ids: '102' });

    expect(body).toMatchObject({ queued: 1 });
    expect(await rescanned()).toEqual([102]);
  });

  it('writes in chunks of 500', async () => {
    await db.exec(`
      INSERT INTO "Image" (id, "postId", ingestion)
      SELECT g, ${JUDGE_POST}, 'PendingManualAssignment' FROM generate_series(1000, 2198) g;
    `);

    const { body } = await call({ dryRun: 'false' });

    // 1199 added + the 2 seeded = 1201 rows: 500 + 500 + 201.
    expect(body).toMatchObject({ queued: 1201 });
    const updates = dbMock.dbWrite.$queryRaw.mock.calls
      .map(([strings, ...values]) => ({ text: (strings as TemplateStringsArray).join(''), values }))
      .filter(({ text }) => text.includes('UPDATE "Image"'));
    expect(updates.map(({ values }) => (values[0] as { values: unknown[] }).values.length)).toEqual(
      [500, 500, 201]
    );
    expect((await rescanned()).length).toBe(1201);
  });

  it('queues an image once when the job is already queued', async () => {
    await db.exec(`INSERT INTO "JobQueue" VALUES ('ImageScan', 'Image', 101)`);

    await call({ dryRun: 'false' });

    expect(await rescanned()).toEqual(IN_SCOPE);
  });
});

const rowId = (r: unknown) => (r as { id: number }).id;
