import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as ModelNsfw from '~/server/services/text-scan/actions/model-nsfw';

/**
 * Two one-off admin endpoints delete posts and images. A held owner's rows are left. The SQL runs
 * on a Postgres stand-in with the real foreign keys.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  WebhookEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/services/article.service', () => ({ recomputeArticleIngestion: vi.fn() }));
vi.mock('~/server/services/image.service', () => ({ invalidateManyImageExistence: vi.fn() }));
vi.mock('~/utils/logging', () => ({ createLogger: () => () => undefined }));
// The held-verdict apply has its own suite; here only that the reset takes the model out of Private
// through it.
const { mockLeavingPrivate } = vi.hoisted(() => ({
  mockLeavingPrivate: vi.fn(async (_db: unknown, _id: number) => false),
}));
vi.mock('~/server/services/text-scan/actions/model-nsfw', async (importOriginal) => ({
  ...(await importOriginal<typeof ModelNsfw>()),
  applyHeldVerdictLeavingPrivate: mockLeavingPrivate,
  finishHeldVerdictApply: vi.fn(async () => undefined),
}));

const { mockArchiveUserComments } = vi.hoisted(() => ({
  mockArchiveUserComments: vi.fn(async (userId: number) => ({
    userId,
    key: `${userId}/comments.json`,
    etag: null,
    comments: 1,
  })),
}));
vi.mock('~/server/services/csam.service-new', () => ({
  archiveUserComments: mockArchiveUserComments,
}));
import archiveHeldUserComments from '~/pages/api/admin/temp/archive-held-user-comments';
import resetTrainingModel from '~/pages/api/admin/temp/reset-training-model';
import migrateArticleImages from '~/pages/api/admin/temp/migrate-article-images';
import '~/__tests__/mocks/logging.mock';

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
const left = async (table: string) =>
  (await db.query<{ id: number }>(`SELECT id FROM "${table}"`)).rows.map((r) => r.id);

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
  await db.exec(`TRUNCATE "Image", "Post", "ImageConnection", "TagsOnImageNew" CASCADE`);
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementation((async (
    ops: Promise<unknown>[] | ((tx: unknown) => unknown)
  ) => (typeof ops === 'function' ? ops(dbMock.dbWrite) : Promise.all(ops))) as never);
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation(
    (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await run(first, values)).rows) as never
  );
  vi.mocked(dbMock.dbWrite.$executeRaw).mockImplementation(
    (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      (await run(first, values)).affectedRows ?? 0) as never
  );
});

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

  it('deletes the posts and their images, not just unlinks the images (control)', async () => {
    await seed(OWNER);
    await call();
    expect(await left('Post')).toEqual([]);
    expect(await left('Image')).toEqual([]);
  });

  it('takes the model out of Private with any held scan verdict, in one transaction', async () => {
    await seed(OWNER);
    const tx = { model: { update: vi.fn() } };
    vi.mocked(dbMock.dbWrite.$transaction).mockImplementationOnce((async (
      fn: (t: unknown) => unknown
    ) => fn(tx)) as never);
    await call();
    expect(tx.model.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ availability: 'Public' }) })
    );
    expect(dbMock.dbWrite.model.update).not.toHaveBeenCalled();
    expect(mockLeavingPrivate).toHaveBeenCalledTimes(1);
    expect(mockLeavingPrivate.mock.calls[0]).toEqual([tx, 5]);
  });

  it.each([HELD, MARKED])("leaves a held owner's post and image (owner %i)", async (owner) => {
    await seed(owner);
    await call();
    expect(await left('Post')).toEqual([10]);
    expect(await left('Image')).toEqual([20]);
  });
});

describe('migrate-article-images rollback', () => {
  const seed = (owner: number) =>
    db.exec(`
      INSERT INTO "Image" (id, "userId") VALUES (30, ${owner});
      INSERT INTO "ImageConnection" VALUES (30, 7, 'Article');
      INSERT INTO "TagsOnImageNew" VALUES (30);
    `);
  const call = () =>
    migrateArticleImages(
      { query: { rollback: 'true', dryRun: 'false' } } as never,
      fakeRes() as never
    );
  const tags = async () => (await db.query(`SELECT 1 FROM "TagsOnImageNew"`)).rows.length;

  it("deletes an unheld owner's article-only image, and its tags (control)", async () => {
    await seed(OWNER);
    await call();
    expect(await left('Image')).toEqual([]);
    expect(await tags()).toBe(0);
  });

  it.each([HELD, MARKED])(
    "leaves a held owner's article-only image, and its tags (owner %i)",
    async (owner) => {
      await seed(owner);
      await call();
      expect(await left('Image')).toEqual([30]);
      expect(await tags()).toBe(1);
    }
  );
});

describe('archive-held-user-comments', () => {
  beforeEach(() => {
    vi.mocked(dbMock.dbRead.$queryRaw).mockImplementation(
      (async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
        (await run(first, values)).rows) as never
    );
  });
  const call = async (dryRun: boolean) => {
    const res = fakeRes();
    await archiveHeldUserComments({ query: { dryRun: String(dryRun) } } as never, res as never);
    return res;
  };

  it('archives each user a report or a hold marker holds, and no one else', async () => {
    await db.exec(`
      INSERT INTO "CsamReport" ("userId", "reportSentAt", "archivedAt")
        VALUES (4, now() - interval '2 years', now() - interval '2 years');
      INSERT INTO "CsamReport" ("userId", details) VALUES (${HELD}, '{"secondaryUserId": "5"}');
    `);
    try {
      expect((await call(true)).body).toMatchObject({ userIds: [HELD, MARKED, 5] });
      expect(mockArchiveUserComments).not.toHaveBeenCalled();

      const res = await call(false);
      expect(mockArchiveUserComments.mock.calls.map(([id]) => id)).toEqual([HELD, MARKED, 5]);
      expect(res).toMatchObject({ statusCode: 200, body: { users: 3, comments: 3 } });
    } finally {
      await db.exec(`DELETE FROM "CsamReport" WHERE "userId" = 4 OR details ? 'secondaryUserId'`);
    }
  });
});
