import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as RedisCaches from '~/server/redis/caches';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const bustCachesForPosts = vi.fn(async (_postIds: number[]) => undefined);
vi.mock('~/server/services/post.service', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  bustCachesForPosts: (postIds: number[]) => bustCachesForPosts(postIds),
}));
vi.mock('~/shared/constants/basemodel.constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  matureRestrictedBaseModels: () => ['Restricted'],
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  imageResourcesCache: { refresh: vi.fn(async () => undefined) },
}));

const { createImageResources } = await import('~/server/services/image.service');
const { flagImagesOnRestrictedVersions } = await import(
  '~/server/services/restricted-images.service'
);

const RESTRICTED_VERSION = 1;
const OPEN_VERSION = 2;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "baseModel" text NOT NULL);
    CREATE TABLE "ImageResourceNew" (
      "imageId" int NOT NULL, "modelVersionId" int NOT NULL, strength real, detected boolean,
      PRIMARY KEY ("imageId", "modelVersionId")
    );
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int, "modelRestricted" boolean NOT NULL DEFAULT false);
    -- What get_image_resources() would derive from each image's meta.
    CREATE TABLE detected_resources (
      id int, modelversionid int, name text, hash text, strength real, detected boolean
    );
    CREATE FUNCTION get_image_resources(image_id int) RETURNS SETOF detected_resources
      LANGUAGE sql AS $$ SELECT * FROM detected_resources WHERE id = image_id $$;

    INSERT INTO "ModelVersion" VALUES (${RESTRICTED_VERSION}, 'Restricted'), (${OPEN_VERSION}, 'Open');
  `);
  // Integers typed as Prisma sends them: untyped, `"modelVersionId" IN ($1)` compares int to text.
  const INT4_OID = 23;
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const { Prisma: P } = await import('@prisma/client');
    const sql = Array.isArray(strings)
      ? P.sql(strings as TemplateStringsArray, ...values)
      : (strings as Prisma.Sql);
    const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
    return (await db.query(sql.text, sql.values, { paramTypes })).rows;
  }) as never);
});
afterAll(() => db.close());

beforeEach(async () => {
  bustCachesForPosts.mockClear();
  await db.exec(`TRUNCATE "Image", "ImageResourceNew", detected_resources`);
  dbMock.dbWrite.image.findUnique.mockResolvedValue({ meta: {} } as never);
});

const restrictedIds = async () =>
  (
    await db.query<{ id: number }>(`SELECT id FROM "Image" WHERE "modelRestricted" ORDER BY id`)
  ).rows.map((r) => r.id);

describe('createImageResources', () => {
  it('restricts an image as its resources on a restricted base model are written', async () => {
    await db.exec(`
      INSERT INTO "Image" VALUES (1, 7, false), (2, 8, false);
      INSERT INTO detected_resources VALUES
        (1, ${OPEN_VERSION}, 'lora', 'aaaaaaaaaa', 0.8, true),
        (1, ${RESTRICTED_VERSION}, 'checkpoint', 'bbbbbbbbbb', NULL, true),
        (2, ${OPEN_VERSION}, 'lora', 'aaaaaaaaaa', 0.8, true);
    `);

    await createImageResources({ imageId: 1 });
    await createImageResources({ imageId: 2 });

    expect(await restrictedIds()).toEqual([1]);
    expect(bustCachesForPosts.mock.calls).toEqual([[[7]]]);
  });

  describe("inside a caller's transaction", () => {
    const tx = dbMock.dbWrite as unknown as Prisma.TransactionClient;
    beforeEach(() =>
      db.exec(`
        INSERT INTO "Image" VALUES (1, NULL, false);
        INSERT INTO detected_resources VALUES
          (1, ${RESTRICTED_VERSION}, 'checkpoint', 'bbbbbbbbbb', NULL, true);
      `)
    );

    it('restricts the image', async () => {
      await createImageResources({ imageId: 1, tx });

      expect(await restrictedIds()).toEqual([1]);
    });

    it('fails the write when the flag cannot be set, since the transaction is already aborted', async () => {
      const query = dbMock.dbWrite.$queryRaw.getMockImplementation()!;
      dbMock.dbWrite.$queryRaw.mockImplementation(((
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) =>
        strings.join('').includes('UPDATE "Image"')
          ? Promise.reject(new Error('statement timeout'))
          : query(strings, ...values)) as never);
      try {
        await expect(createImageResources({ imageId: 1, tx })).rejects.toThrow('statement timeout');
      } finally {
        dbMock.dbWrite.$queryRaw.mockImplementation(query);
      }
    });
  });
});

describe('flagImagesOnRestrictedVersions', () => {
  beforeEach(() =>
    db.exec(`
      INSERT INTO "Image" VALUES (1, 7, false), (2, 7, false), (3, NULL, false), (4, 8, true);
      INSERT INTO "ImageResourceNew" VALUES
        (1, ${RESTRICTED_VERSION}, NULL, false), (2, ${RESTRICTED_VERSION}, NULL, false),
        (3, ${OPEN_VERSION}, NULL, false), (4, ${RESTRICTED_VERSION}, NULL, false);
    `)
  );

  it('flags only the images it is given', async () => {
    const result = await flagImagesOnRestrictedVersions({
      modelVersionIds: [RESTRICTED_VERSION, OPEN_VERSION],
      imageIds: [1, 3, 4],
    });

    expect(result).toEqual({ flagged: 1, postIds: [7] });
    expect(await restrictedIds()).toEqual([1, 4]);
  });

  it('flags every image of a restricted version when no images are given', async () => {
    expect(await flagImagesOnRestrictedVersions({ modelVersionIds: [RESTRICTED_VERSION] })).toEqual(
      {
        flagged: 2,
        postIds: [7],
      }
    );
    expect(await restrictedIds()).toEqual([1, 2, 4]);
  });

  it('leaves images alone when none of the versions are restricted', async () => {
    expect(await flagImagesOnRestrictedVersions({ modelVersionIds: [OPEN_VERSION] })).toEqual({
      flagged: 0,
      postIds: [],
    });
    expect(await restrictedIds()).toEqual([4]);
  });

  it('reports a database error instead of failing the write that called it', async () => {
    dbMock.dbWrite.$queryRaw.mockRejectedValueOnce(new Error('connection reset'));

    await expect(
      flagImagesOnRestrictedVersions({ modelVersionIds: [RESTRICTED_VERSION], imageIds: [1] })
    ).resolves.toEqual({ flagged: 0, postIds: [] });
  });
});
