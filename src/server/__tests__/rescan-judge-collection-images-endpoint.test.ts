import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { Prisma } from '@prisma/client';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { legacyJudgeRatingSeedSql } from '~/server/common/judge-rating';
import { IMAGE_RESCAN_RETRY_LIMIT } from '~/server/services/image-scan-failure';

/**
 * The rescan endpoint's real SQL against an in-process Postgres: it touches only images posted to
 * a judge-rated collection that are Scanned without scanJobs or PendingManualAssignment, and writes
 * only the scan queue plus a legacy judge rating. Ids are invented.
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
const X = 8;

// In scope: 101 Scanned without scanJobs (level X), 102 pending manual assignment (unrated).
// Out of scope: 103 scanned normally, 104 blocked, 105 pending scan, 106/107 in a plain collection.
const IN_SCOPE = [101, 102];

let db: PGlite;
let raw: ReturnType<typeof pgliteRaw>;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "JobQueueType" AS ENUM ('ImageScan', 'CleanUp');
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "TagSource" AS ENUM ('User', 'WD14', 'Rekognition');
    CREATE TABLE "Collection" (id int PRIMARY KEY, metadata jsonb NOT NULL DEFAULT '{}');
    CREATE TABLE "Post" (id int PRIMARY KEY, "collectionId" int REFERENCES "Collection"(id));
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "postId" int REFERENCES "Post"(id),
      ingestion "ImageIngestionStatus" NOT NULL,
      "scanJobs" jsonb,
      "blockedFor" text,
      "nsfwLevel" int NOT NULL DEFAULT 0,
      metadata jsonb,
      "needsReview" text,
      "updatedAt" timestamp(3) NOT NULL DEFAULT '2025-01-02 03:04:05'
    );
    CREATE TABLE "TagsOnImageDetails" (
      "imageId" int NOT NULL, "tagId" int NOT NULL, source "TagSource" NOT NULL
    );
    CREATE TABLE "JobQueue" (
      type "JobQueueType" NOT NULL,
      "entityType" "EntityType" NOT NULL,
      "entityId" int NOT NULL,
      PRIMARY KEY ("entityType", "entityId", type)
    );
  `);
  await installTagRecompute({ withFloor: true });
  raw = pgliteRaw(db);
});

/** Stands in for `update_nsfw_levels_new`; the endpoint reads only whether its body has the floor. */
async function installTagRecompute({ withFloor }: { withFloor: boolean }) {
  await db.exec(`
    CREATE OR REPLACE FUNCTION update_nsfw_levels_new(image_ids INTEGER[]) RETURNS VOID AS $$
    BEGIN
      PERFORM ${withFloor ? `(metadata -> 'judgeRating') FROM "Image"` : `1`};
    END;
    $$ LANGUAGE plpgsql;
  `);
}
afterAll(() => db.close());

async function seedBase() {
  await db.exec(`
    DELETE FROM "JobQueue"; DELETE FROM "TagsOnImageDetails"; DELETE FROM "Image";
    DELETE FROM "Post"; DELETE FROM "Collection";
    INSERT INTO "Collection" (id, metadata) VALUES
      (${JUDGE_COLLECTION}, '{"judgesApplyBrowsingLevel": true}'),
      (${PLAIN_COLLECTION}, '{}');
    INSERT INTO "Post" (id, "collectionId") VALUES
      (${JUDGE_POST}, ${JUDGE_COLLECTION}), (${PLAIN_POST}, ${PLAIN_COLLECTION});
    INSERT INTO "Image" (id, "postId", ingestion, "scanJobs", "blockedFor", "nsfwLevel") VALUES
      (101, ${JUDGE_POST}, 'Scanned', NULL, NULL, ${X}),
      (102, ${JUDGE_POST}, 'PendingManualAssignment', NULL, NULL, 0),
      (103, ${JUDGE_POST}, 'Scanned', '{"workflowId": "wf"}', NULL, 1),
      (104, ${JUDGE_POST}, 'Blocked', NULL, 'tos', 32),
      (105, ${JUDGE_POST}, 'Pending', NULL, NULL, 0),
      (106, ${PLAIN_POST}, 'Scanned', NULL, NULL, 1),
      (107, ${PLAIN_POST}, 'PendingManualAssignment', NULL, NULL, 0);
    INSERT INTO "TagsOnImageDetails" VALUES (103, 1, 'WD14'), (101, 2, 'User');
  `);
}

type SnapshotRow = { id: number; queued: number; metadata: unknown };
const snapshot = async () =>
  (
    await db.query(
      `SELECT i.id, i.ingestion, i."scanJobs", i."blockedFor", i."nsfwLevel", i.metadata,
        (SELECT count(*)::int FROM "JobQueue" q WHERE q."entityId" = i.id) AS queued
       FROM "Image" i ORDER BY i.id`
    )
  ).rows as SnapshotRow[];

const rescanned = async () =>
  (
    await db.query<{ id: number }>(
      `SELECT i.id FROM "Image" i
       JOIN "JobQueue" q ON q."entityId" = i.id AND q.type = 'ImageScan' AND q."entityType" = 'Image'
       WHERE i.ingestion = 'Rescan' ORDER BY i.id`
    )
  ).rows.map((r) => r.id);

async function call(query: Record<string, string>, method = 'POST') {
  let statusCode = 0;
  let body: Record<string, unknown> = {};
  const req = { method, query: { token: 'test-token', ...query }, headers: {} } as never;
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
  dbMock.dbRead.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$queryRaw.mockImplementation(raw.queryRaw as never);
  dbMock.dbWrite.$executeRaw.mockImplementation(raw.executeRaw as never);
  await installTagRecompute({ withFloor: true });
  await seedBase();
});

describe('rescan-judge-collection-images: dry run', () => {
  it('is the default: counts, wide markers and scanner-tag checks, and writes nothing', async () => {
    const before = await snapshot();

    const { statusCode, body } = await call({});

    expect(statusCode).toBe(200);
    expect(body).toEqual({
      dryRun: true,
      cohorts: { scannedNoJobs: 1, pendingManual: 1, outOfRetries: 0 },
      heldForReview: 0,
      floorMigrationApplied: true,
      // 106 and 107 carry the same markers in a collection without the flag.
      wide: { scannedNoJobs: 2, pendingManual: 2 },
      controls: { inScopeWithScannerTags: 0, outOfScopeScannedWithoutScannerTags: 0 },
    });
    expect(await snapshot()).toEqual(before);
  });

  it('reports scope rows the scanner tags disagree with', async () => {
    await db.exec(`
      INSERT INTO "TagsOnImageDetails" VALUES (101, 3, 'WD14');
      DELETE FROM "TagsOnImageDetails" WHERE "imageId" = 103;
    `);

    const { body } = await call({});

    expect(body.controls).toEqual({
      inScopeWithScannerTags: 1,
      outOfScopeScannedWithoutScannerTags: 1,
    });
  });

  it('counts in-scope images held for moderator review', async () => {
    await db.exec(`UPDATE "Image" SET "needsReview" = 'minor' WHERE id IN (101, 103)`);

    const { body } = await call({});

    // 103 is held but out of scope.
    expect(body.heldForReview).toBe(1);
  });

  it('refuses to write from a GET', async () => {
    const before = await snapshot();

    const { statusCode } = await call({ dryRun: 'false' }, 'GET');

    expect(statusCode).toBe(405);
    expect(await snapshot()).toEqual(before);
  });
});

describe('rescan-judge-collection-images: a run', () => {
  it('marks an in-scope image out of rescan retries as Error, seeded and not queued', async () => {
    await db.exec(
      `UPDATE "Image" SET "scanJobs" = '{"retryCount": ${IMAGE_RESCAN_RETRY_LIMIT}}' WHERE id = 102`
    );
    await db.exec(`UPDATE "Image" SET "nsfwLevel" = 2 WHERE id = 102`);

    const dry = await call({});
    expect(dry.body.cohorts).toEqual({ scannedNoJobs: 1, pendingManual: 1, outOfRetries: 1 });

    const { body } = await call({ dryRun: 'false' });

    expect(body).toMatchObject({ queued: 1, markedError: 1 });
    expect(await rescanned()).toEqual([101]);
    const row = (await snapshot()).find((r) => r.id === 102) as unknown as {
      ingestion: string;
      queued: number;
      metadata: { judgeRating: { legacy: boolean; nsfwLevel: number } };
    };
    expect(row.ingestion).toBe('Error');
    expect(row.queued).toBe(0);
    expect(row.metadata.judgeRating).toMatchObject({ legacy: true, nsfwLevel: 2 });
  });

  it('refuses to start, writing nothing, until the tag recompute carries the judge floor', async () => {
    await installTagRecompute({ withFloor: false });
    const before = await snapshot();

    expect((await call({})).body).toMatchObject({ floorMigrationApplied: false });
    const { statusCode, body } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(400);
    expect(body).toEqual({ error: 'The judge-rating floor migration is not applied' });
    expect(await snapshot()).toEqual(before);
  });

  it('refuses to start when the tag recompute does not exist', async () => {
    await db.exec(`DROP FUNCTION update_nsfw_levels_new(INTEGER[])`);
    const before = await snapshot();

    const { statusCode } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['false', ''],
    ['true', ''],
    ['false', '101,0'],
    ['false', '101,abc'],
  ])(
    'refuses an id list that is empty or not positive ids (dryRun=%s, ids=%j)',
    async (dryRun, ids) => {
      const before = await snapshot();

      const { statusCode, body } = await call({ dryRun, ids });

      expect(statusCode).toBe(400);
      expect(body).toEqual({ error: 'Invalid query' });
      expect(await snapshot()).toEqual(before);
    }
  );

  it('refuses to start, writing nothing, while an in-scope image is held for review', async () => {
    await db.exec(`UPDATE "Image" SET "needsReview" = 'poi' WHERE id = 102`);
    const before = await snapshot();

    const { statusCode, body } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(400);
    expect(body).toEqual({
      error: 'Some in-scope images are held for moderator review',
      heldForReview: 1,
    });
    expect(await snapshot()).toEqual(before);
  });

  it('skips an image held for review after the check', async () => {
    dbMock.dbRead.$queryRaw.mockImplementation((async (
      ...args: Parameters<typeof raw.queryRaw>
    ) => {
      const rows = await raw.queryRaw(...args);
      const text = Array.isArray(args[0]) ? (args[0] as string[]).join('') : '';
      if (text.includes('ORDER BY i.id'))
        await db.exec(`UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 101`);
      return rows;
    }) as never);

    await call({ dryRun: 'false' });

    expect(await rescanned()).toEqual([102]);
  });

  it('queues both cohorts and nothing else, keeping the applied level as a floor', async () => {
    const before = await snapshot();
    // The seed the run must write, from the shared helper against the row as it stands.
    const [{ metadata: seeded }] = (await raw.queryRaw`
      SELECT ${legacyJudgeRatingSeedSql('i', Prisma.sql`p."collectionId"`)} AS metadata
      FROM "Image" i JOIN "Post" p ON p.id = i."postId" WHERE i.id = 101
    `) as { metadata: { judgeRating: Record<string, unknown> } }[];
    expect(seeded.judgeRating).toMatchObject({ legacy: true, nsfwLevel: X, ratedAt: null });

    const { statusCode, body } = await call({ dryRun: 'false' });

    expect(statusCode).toBe(200);
    expect(body).toMatchObject({ dryRun: false, queued: 2 });
    expect(await rescanned()).toEqual(IN_SCOPE);
    const rows = await snapshot();
    expect(rows.filter((r) => !IN_SCOPE.includes(r.id))).toEqual(
      before.filter((r) => !IN_SCOPE.includes(r.id))
    );
    expect(rows.filter((r) => IN_SCOPE.includes(r.id))).toEqual([
      {
        id: 101,
        ingestion: 'Rescan',
        scanJobs: null,
        blockedFor: null,
        nsfwLevel: X,
        metadata: seeded,
        queued: 1,
      },
      // Unrated: no level to keep.
      {
        id: 102,
        ingestion: 'Rescan',
        scanJobs: null,
        blockedFor: null,
        nsfwLevel: 0,
        metadata: null,
        queued: 1,
      },
    ]);
  });

  it('keeps a judge rating already on the row', async () => {
    const existing = { userId: 5, nsfwLevel: 4, collectionId: JUDGE_COLLECTION };
    await db.query(`UPDATE "Image" SET metadata = $1 WHERE id = 101`, [{ judgeRating: existing }]);

    await call({ dryRun: 'false' });

    expect((await snapshot()).find((r) => r.id === 101)?.metadata).toEqual({
      judgeRating: existing,
    });
  });

  it('skips a row that left the scope after it was read', async () => {
    dbMock.dbRead.$queryRaw.mockImplementation((async (
      ...args: Parameters<typeof raw.queryRaw>
    ) => {
      const rows = await raw.queryRaw(...args);
      const text = Array.isArray(args[0]) ? (args[0] as string[]).join('') : '';
      // The id read the run batches from; 101 is scanned before its batch is written.
      if (text.includes('ORDER BY i.id'))
        await db.exec(`UPDATE "Image" SET "scanJobs" = '{"workflowId": "wf"}' WHERE id = 101`);
      return rows;
    }) as never);

    const { body } = await call({ dryRun: 'false' });

    expect(body).toMatchObject({ queued: 1 });
    expect(await rescanned()).toEqual([102]);
    expect((await snapshot()).find((r) => r.id === 101)).toMatchObject({
      ingestion: 'Scanned',
      metadata: null,
      queued: 0,
    });
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
    // The id list is the largest interpolated value list in each UPDATE.
    const batchSize = (values: unknown[]) =>
      Math.max(...values.map((v) => (v as { values?: unknown[] })?.values?.length ?? 0));
    expect(updates.map(({ values }) => batchSize(values))).toEqual([500, 500, 201]);
    expect((await rescanned()).length).toBe(1201);
  });

  it('queues an image once when the job is already queued', async () => {
    await db.exec(`INSERT INTO "JobQueue" VALUES ('ImageScan', 'Image', 101)`);

    await call({ dryRun: 'false' });

    expect(await rescanned()).toEqual(IN_SCOPE);
  });
});
