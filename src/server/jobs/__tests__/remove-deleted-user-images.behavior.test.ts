import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { DELETED_ROW_COLUMNS_SQL } from '../../services/__tests__/deleted-row-columns.fixture';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { readFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

/**
 * The deleted-account drain, its own statements run against a Postgres stand-in. `deleteImages` is
 * replaced by its row DELETE.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { mockDeleteImages, hooks } = vi.hoisted(() => ({
  mockDeleteImages: vi.fn(),
  hooks: {
    beforeDelete: null as null | ((ids: number[]) => Promise<void>),
    afterWorklist: null as null | (() => Promise<void>),
  },
}));

vi.mock('~/server/services/image.service', () => ({
  deleteImages: mockDeleteImages,
  queueImageSearchIndexUpdate: vi.fn(async () => undefined),
  invalidateManyImageExistence: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/post.service', () => ({
  bustCachesForPosts: vi.fn(async () => undefined),
}));
vi.mock('~/server/jobs/job', () => ({
  createJob: (_n: string, _c: string, fn: unknown) => fn,
  getJobDate: vi.fn(async (_key: string, defaultValue: Date) => [defaultValue, vi.fn()]),
}));

import { removeDeletedUserImages } from '~/server/jobs/remove-deleted-user-images';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';

const holder = vi.hoisted(() => ({ db: null as unknown as PGlite }));

const REPORTED = 1; // named on a pending CSAM report
const PLAIN = 2;
const COMMENTER = 4;
const MANY = 150; // more than one delete batch

const run = () =>
  (
    removeDeletedUserImages as unknown as (ctx: { checkIfCanceled: () => void }) => Promise<unknown>
  )({ checkIfCanceled: () => undefined });

const toSql = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) =>
  Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);

const imagesOf = async (userId: number) =>
  (await holder.db.query(`SELECT 1 FROM "Image" WHERE "userId" = $1`, [userId])).rows.length;
const postsOf = async (userId: number) =>
  (await holder.db.query(`SELECT 1 FROM "Post" WHERE "userId" = $1`, [userId])).rows.length;

beforeAll(async () => {
  holder.db = new PGlite();
  await holder.db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "User" (id int PRIMARY KEY, "deletedAt" timestamp(3), meta jsonb, "bannedAt" timestamp(3));
    CREATE TABLE "ModActivity" (
      id serial PRIMARY KEY, "userId" int, activity text NOT NULL, "entityType" text, "entityId" int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp, metadata jsonb);
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      "userId" int NOT NULL,
      "postId" int,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "blockedFor" text,
      "needsReview" text,
      "nsfwLevel" int NOT NULL DEFAULT 1,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      metadata jsonb NOT NULL DEFAULT '{}',
      "updatedAt" timestamp(3)
    );
    CREATE TABLE "Thread" (
      id int PRIMARY KEY, "postId" int UNIQUE REFERENCES "Post"(id) ON DELETE CASCADE,
      "imageId" int, "parentThreadId" int, "rootThreadId" int, "commentId" int,
      metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "CommentV2" (
      id int PRIMARY KEY, "userId" int NOT NULL,
      "threadId" int NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE
    );
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY,
      "userId" int,
      "reportSentAt" timestamp(3),
      "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}',
      images jsonb NOT NULL DEFAULT '[]'
    );
  `);
  await holder.db.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM ('PendingDelete', 'ImageStorageDelete', 'UpdateNsfwLevel', 'CdnAccessSync', 'BlockedImageDelete');
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
    );
  `);
  await holder.db.exec(imageUseTablesSql);
  // The drain asks it whether a post holds held text: the shape the drop migration leaves.
  const migrations = path.resolve(
    __dirname,
    '../../../../packages/civitai-db-schema/prisma/migrations'
  );
  await holder.db.exec(`CREATE TABLE "EvidenceHeldUser" ("userId" int)`);
  await holder.db.exec(
    readFileSync(path.join(migrations, '20270108093000_post_text/migration.sql'), 'utf8')
  );
  await holder.db.exec(`DROP TABLE "EvidenceHeldUser"`);
  const drop = readFileSync(
    path.join(migrations, '20271127120000_drop_legal_holds/migration.sql'),
    'utf8'
  );
  const start = drop.indexOf('CREATE OR REPLACE FUNCTION post_text_held(');
  await holder.db.exec(drop.slice(start, drop.indexOf('pg_temp;', start) + 'pg_temp;'.length));
  await holder.db.exec(DELETED_ROW_COLUMNS_SQL);
});

beforeEach(async () => {
  vi.clearAllMocks();
  hooks.beforeDelete = null;
  hooks.afterWorklist = null;
  redisMock.sysRedis.get.mockResolvedValue('1000');

  const query = (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = toSql(first, values);
    const { rows } = await holder.db.query(sql.text, sql.values as unknown[]);
    // After the worklist that actually picked the users up (the fresh one comes back empty here).
    if (hooks.afterWorklist && sql.text.includes('m.mode') && rows.length)
      await hooks.afterWorklist();
    return rows;
  }) as never;
  const execute = (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = toSql(first, values);
    return (await holder.db.query(sql.text, sql.values as unknown[])).affectedRows ?? 0;
  }) as never;
  vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(query);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(query);
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(execute);

  // The row DELETE `deleteImages` runs, with `onlyWhere` composed into it the same way.
  mockDeleteImages.mockImplementation(async (ids: number[], opts?: { onlyWhere?: Prisma.Sql }) => {
    if (hooks.beforeDelete) await hooks.beforeDelete(ids);
    const where = opts?.onlyWhere ? Prisma.sql`AND (${opts.onlyWhere})` : Prisma.empty;
    const sql = Prisma.sql`DELETE FROM "Image" WHERE id = ANY(${ids}::int[]) ${where} RETURNING id`;
    const { rows } = await holder.db.query<{ id: number }>(sql.text, sql.values as unknown[]);
    return rows;
  });

  await holder.db.exec(`
    TRUNCATE "User", "Thread", "Post", "Image", "CsamReport" CASCADE;
    INSERT INTO "User" (id, "deletedAt", meta) VALUES
      (${REPORTED}, now() - interval '1 day', '{}'),
      (${PLAIN}, now() - interval '1 day', '{}');
    INSERT INTO "Post" (id, "userId") VALUES (901, ${REPORTED}), (902, ${PLAIN});
    INSERT INTO "Image" (id, "userId", "postId")
      SELECT g, ${REPORTED}, 901 FROM generate_series(1, ${MANY}) g;
    INSERT INTO "Image" (id, "userId", "postId")
      SELECT g, ${PLAIN}, 902 FROM generate_series(1001, 1005) g;
  `);
});

describe('remove-deleted-user-images', () => {
  // No account-wide hold: in-case images are kept by the delete's own case check.
  it('drains an account named on a pending CSAM report, posts and all', async () => {
    await holder.db.exec(`INSERT INTO "CsamReport" ("userId") VALUES (${REPORTED})`);

    await run();

    expect(await imagesOf(REPORTED)).toBe(0);
    expect(await postsOf(REPORTED)).toBe(0);
    expect(await imagesOf(PLAIN)).toBe(0);
    expect(await postsOf(PLAIN)).toBe(0);
  });

  it("records each grace-blocked image's rating and rating lock before blocking it", async () => {
    await holder.db.exec(`
      UPDATE "User" SET meta = '{"imageRemoval": "grace"}' WHERE id = ${PLAIN};
      UPDATE "Image" SET "nsfwLevel" = 4, "nsfwLevelLocked" = true WHERE id = 1001;
      UPDATE "Image" SET "nsfwLevel" = 32, ingestion = 'Error' WHERE id = 1002;
      -- Already blocked for an unverified AI claim: the job re-points it rather than hiding it.
      UPDATE "Image" SET "nsfwLevel" = 8, ingestion = 'Blocked', "blockedFor" = 'AiNotVerified' WHERE id = 1003;
    `);

    await run();

    const { rows } = await holder.db.query<{
      id: number;
      nsfwLevel: number;
      metadata: Record<string, unknown>;
    }>(`SELECT id, "nsfwLevel", metadata FROM "Image" WHERE id IN (1001, 1002, 1003) ORDER BY id`);
    // Control: the grace block ran and replaced the rating; the re-point leaves it.
    expect(rows.map((row) => row.nsfwLevel)).toEqual([32, 32, 8]);
    expect(rows.map((row) => row.metadata)).toEqual([
      expect.objectContaining({
        accountDeletionPriorNsfwLevel: 4,
        accountDeletionPriorNsfwLevelLocked: true,
      }),
      expect.objectContaining({
        accountDeletionPriorNsfwLevel: 32,
        accountDeletionPriorNsfwLevelLocked: false,
      }),
      expect.objectContaining({
        accountDeletionPriorBlockedFor: 'AiNotVerified',
        accountDeletionPriorNsfwLevel: 8,
        accountDeletionPriorNsfwLevelLocked: false,
      }),
    ]);
  });

  it('takes the comments on a drained post with it', async () => {
    await holder.db.exec(`
      INSERT INTO "Thread" (id, "postId") VALUES (100, 902);
      INSERT INTO "CommentV2" VALUES (1, ${COMMENTER}, 100);
    `);

    await run();

    expect(await postsOf(PLAIN)).toBe(0);
    const { rows } = await holder.db.query<{ id: number }>(`SELECT id FROM "CommentV2"`);
    expect(rows).toEqual([]);
  });
});
