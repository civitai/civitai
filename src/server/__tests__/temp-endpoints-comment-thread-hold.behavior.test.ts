import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

/**
 * Two one-off admin endpoints delete posts and images, which cascades into their comment threads.
 * A thread holding a retained author's comment is detached first. The SQL runs on a Postgres
 * stand-in with the real foreign keys.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/article.service', () => ({ recomputeArticleIngestion: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ invalidateManyImageExistence: vi.fn() }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));

import resetTrainingModel from '~/pages/api/admin/temp/reset-training-model';
import migrateArticleImages from '~/pages/api/admin/temp/migrate-article-images';

const OWNER = 1;
const HELD = 2; // named on a pending report
const MARKED = 3; // held by a hold marker

let db: PGlite;
const run = (first: TemplateStringsArray | Prisma.Sql, values: unknown[]) => {
  const sql = Array.isArray(first)
    ? Prisma.sql(first as TemplateStringsArray, ...(values as never[]))
    : (first as Prisma.Sql);
  return db.query(sql.text, sql.values as unknown[]);
};
const fakeRes = () => {
  const res = { statusCode: 200, body: undefined as unknown };
  return Object.assign(res, {
    status: (code: number) => Object.assign(res, { statusCode: code }) && res,
    json: (body: unknown) => Object.assign(res, { body }) && res,
  });
};
const commentIds = async () =>
  (await db.query<{ id: number }>(`SELECT id FROM "CommentV2" ORDER BY id`)).rows.map((r) => r.id);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "CsamReport" (
      id serial PRIMARY KEY, "userId" int, "reportSentAt" timestamp(3), "archivedAt" timestamp(3),
      details jsonb NOT NULL DEFAULT '{}', images jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE "EvidenceHold" ("userId" int NOT NULL);
    CREATE VIEW "EvidenceHeldUser" AS SELECT "userId" FROM "EvidenceHold";
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int REFERENCES "Post"(id) ON DELETE SET NULL,
      "needsReview" text, "blockedFor" text
    );
    CREATE TABLE "Thread" (
      id int PRIMARY KEY,
      "postId" int UNIQUE REFERENCES "Post"(id) ON DELETE CASCADE,
      "imageId" int UNIQUE REFERENCES "Image"(id) ON DELETE CASCADE,
      "parentThreadId" int, "rootThreadId" int, "commentId" int, metadata jsonb NOT NULL DEFAULT '{}'
    );
    CREATE TABLE "CommentV2" (
      id int PRIMARY KEY, "userId" int NOT NULL,
      "threadId" int NOT NULL REFERENCES "Thread"(id) ON DELETE CASCADE
    );
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
    CREATE TABLE "TagsOnImageNew" ("imageId" int);
    CREATE TABLE "ImageResourceNew" ("imageId" int);
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int);
    CREATE TABLE "UserProfile" ("coverImageId" int);
    CREATE TABLE "Article" (id int PRIMARY KEY, "coverId" int);
    CREATE TABLE "Challenge" ("coverImageId" int);
    INSERT INTO "CsamReport" ("userId") VALUES (${HELD});
    INSERT INTO "EvidenceHold" VALUES (${MARKED});
  `);
});
afterAll(() => db.close());

beforeEach(async () => {
  vi.clearAllMocks();
  await db.exec(
    `TRUNCATE "CommentV2", "Thread", "Image", "Post", "ImageConnection", "TagsOnImageNew" CASCADE`
  );
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (ops: Promise<unknown>[]) =>
    Promise.all(ops)) as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(
    (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await run(first, values)).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(
    (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await run(first, values)).affectedRows ?? 0) as never
  );
});

/** A thread on `column` = `id`, with one comment by `author`. */
const seedThread = (column: 'postId' | 'imageId', id: number, author: number) =>
  db.exec(`
    INSERT INTO "Thread" (id, "${column}") VALUES (100, ${id});
    INSERT INTO "CommentV2" VALUES (1, ${author}, 100);
  `);

describe('reset-training-model', () => {
  const seed = (owner: number) =>
    db.exec(`
      INSERT INTO "Post" VALUES (10, ${owner});
      INSERT INTO "Image" (id, "userId", "postId") VALUES (20, ${owner}, 10);
    `);
  beforeEach(() => {
    vi.mocked(dbMock.dbWrite.model.findUnique).mockResolvedValue({
      id: 5,
      uploadType: 'Trained',
    } as never);
    vi.mocked(dbMock.dbWrite.modelVersion.findMany).mockResolvedValue([{ id: 50 }] as never);
    vi.mocked(dbMock.dbWrite.post.findMany).mockResolvedValue([{ id: 10 }] as never);
  });
  const call = () => resetTrainingModel({ query: { id: '5' } } as never, fakeRes() as never);
  const left = async (table: string) =>
    (await db.query<{ id: number }>(`SELECT id FROM "${table}"`)).rows.map((r) => r.id);

  it('deletes the posts and their images, not just unlinks the images', async () => {
    await seed(OWNER);
    await call();
    expect(await left('Post')).toEqual([]);
    expect(await left('Image')).toEqual([]);
  });

  it.each([
    ['post', 'postId', 10, HELD],
    ['image', 'imageId', 20, MARKED],
  ] as const)("keeps a held author's comment on the deleted %s", async (_, column, id, author) => {
    await seed(OWNER);
    await seedThread(column, id, author);
    await call();
    expect(await left('Post')).toEqual([]);
    expect(await commentIds()).toEqual([1]);
  });

  it('takes an unheld comment with the post (control)', async () => {
    await seed(OWNER);
    await seedThread('postId', 10, OWNER);
    await call();
    expect(await commentIds()).toEqual([]);
  });

  it.each([HELD, MARKED])("leaves a held owner's post and image (owner %i)", async (owner) => {
    await seed(owner);
    await call();
    expect(await left('Post')).toEqual([10]);
    expect(await left('Image')).toEqual([20]);
  });
});

describe('migrate-article-images rollback', () => {
  beforeEach(async () => {
    await db.exec(`
      INSERT INTO "Image" (id, "userId") VALUES (30, ${OWNER});
      INSERT INTO "ImageConnection" VALUES (30, 7, 'Article');
    `);
  });
  const call = () =>
    migrateArticleImages(
      { query: { rollback: 'true', dryRun: 'false' } } as never,
      fakeRes() as never
    );

  it("keeps a held author's comment on an article-only image it deletes", async () => {
    await seedThread('imageId', 30, HELD);
    await call();
    expect((await db.query(`SELECT id FROM "Image"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([1]);
  });

  it("leaves a held owner's article-only image, and its tags", async () => {
    await db.exec(`
      UPDATE "Image" SET "userId" = ${HELD} WHERE id = 30;
      INSERT INTO "TagsOnImageNew" VALUES (30);
    `);
    await call();
    expect((await db.query(`SELECT id FROM "Image"`)).rows).toEqual([{ id: 30 }]);
    expect((await db.query(`SELECT 1 FROM "TagsOnImageNew"`)).rows).toHaveLength(1);
  });

  it('keeps a comment by an author only the hold marker covers', async () => {
    await seedThread('imageId', 30, MARKED);
    await call();
    expect(await commentIds()).toEqual([1]);
  });

  it('takes an unheld comment with the image (control)', async () => {
    await seedThread('imageId', 30, OWNER);
    await call();
    expect((await db.query(`SELECT id FROM "Image"`)).rows).toEqual([]);
    expect(await commentIds()).toEqual([]);
  });
});
