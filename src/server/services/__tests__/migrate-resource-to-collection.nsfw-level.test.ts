import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { migrateResourceToCollection } from '~/server/services/model.service';

/**
 * Splitting a model into a collection INSERTs a model per extra version, and the Model trigger
 * fires on UPDATE only, so nothing queues a level recompute for the new models. The split has to
 * run the rollups itself. The rollup SQL runs here against a Postgres stand-in that the mocked
 * creates write into, so the test reads the levels the real statements leave.
 */

const OWNER = 7;
const SOURCE = 1;
const VERSIONS = [10, 11, 12];

let db: PGlite;

async function seed({ sfwCoverOnVersion }: { sfwCoverOnVersion?: number } = {}) {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int, nsfw boolean, "nsfwLevel" int,
      "sfwName" text, "sfwCoverImageId" int);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int, status text, "nsfwLevel" int);
    CREATE TABLE "Post" (id int PRIMARY KEY, "modelVersionId" int, "userId" int,
      "publishedAt" timestamp);
    CREATE TABLE "Image" (id int PRIMARY KEY, "postId" int, "nsfwLevel" int, index int,
      "needsReview" text, "acceptableMinor" boolean DEFAULT false,
      "tosViolation" boolean DEFAULT false, ingestion text DEFAULT 'Scanned');
  `);
  // A mature model whose versions still hold the PG level of their images.
  await db.query(`INSERT INTO "Model" VALUES ($1, $2, true, 61, NULL, NULL)`, [SOURCE, OWNER]);
  for (const v of VERSIONS) {
    await db.query(`INSERT INTO "ModelVersion" VALUES ($1, $2, 'Published', 1)`, [v, SOURCE]);
    await db.query(`INSERT INTO "Post" VALUES ($1, $1, $2, now())`, [v, OWNER]);
    await db.query(`INSERT INTO "Image" (id, "postId", "nsfwLevel", index) VALUES ($1, $1, 1, 0)`, [
      v,
    ]);
  }

  const face = sfwCoverOnVersion
    ? { sfwName: 'Safe name', sfwDescription: 'Safe text', sfwCoverImageId: sfwCoverOnVersion }
    : { sfwName: null, sfwDescription: null, sfwCoverImageId: null };
  vi.mocked(dbMock.dbRead.model.findUnique).mockResolvedValue({
    id: SOURCE,
    name: 'Model',
    userId: OWNER,
    status: 'Published',
    locked: false,
    mode: null,
    tosViolation: false,
    nsfw: true,
    nsfwLevel: 61,
    meta: {},
    gallerySettings: null,
    ...face,
    modelVersions: VERSIONS.map((id) => ({
      id,
      name: `v${id}`,
      status: 'Published',
      nsfwLevel: 1,
    })),
    tagsOnModels: [],
    licenses: [],
    resourceReviews: [],
  } as never);
  // Each version's image is on that version's post, so image id = version id.
  vi.mocked(dbMock.dbRead.image.findUnique).mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => ({ post: { modelVersionId: where.id } })) as never);

  let created = 100;
  vi.mocked(dbMock.dbWrite.model.create).mockImplementation((async ({
    data,
  }: {
    data: Prisma.ModelUncheckedCreateInput & { modelVersions: { connect: { id: number } } };
  }) => {
    const id = ++created;
    await db.query(`INSERT INTO "Model" VALUES ($1, $2, $3, $4, $5, $6)`, [
      id,
      data.userId,
      data.nsfw,
      data.nsfwLevel,
      data.sfwName ?? null,
      data.sfwCoverImageId ?? null,
    ]);
    await db.query(`UPDATE "ModelVersion" SET "modelId" = $1 WHERE id = $2`, [
      id,
      data.modelVersions.connect.id,
    ]);
    return { id };
  }) as never);
  vi.mocked(dbMock.dbWrite.collection.create).mockResolvedValue({ id: 5 } as never);
  vi.mocked(dbMock.dbWrite.$transaction).mockImplementationOnce((async (
    fn: (client: unknown) => unknown
  ) => fn(dbMock.dbWrite)) as never);
  vi.mocked(dbMock.dbWrite.model.update).mockResolvedValue({ id: SOURCE, userId: OWNER } as never);
  vi.mocked(dbMock.dbRead.model.findFirst).mockResolvedValue({
    id: SOURCE,
    userId: OWNER,
    minor: false,
    sfwOnly: false,
    gallerySettings: null,
  } as never);

  // The level rollups run against the stand-in; every other raw statement is not under test.
  vi.mocked(dbMock.dbWrite.$queryRaw).mockImplementation((async (sql: Prisma.Sql) => {
    if (!/UPDATE "Model(Version)?" (m|mv)\s+SET "nsfwLevel"/.test(sql.text)) return [];
    const { rows } = await db.query(sql.text, sql.values);
    return rows;
  }) as never);
}

async function levels() {
  const models = await db.query<{ id: number; nsfwLevel: number }>(
    `SELECT id, "nsfwLevel" FROM "Model" ORDER BY id`
  );
  const versions = await db.query<{ id: number; nsfwLevel: number }>(
    `SELECT id, "nsfwLevel" FROM "ModelVersion" ORDER BY id`
  );
  return { models: models.rows, versions: versions.rows };
}

beforeEach(() => {
  vi.clearAllMocks();
  installFakeCacheRedis();
});
afterEach(async () => {
  await db?.close();
});

describe('migrateResourceToCollection nsfw levels', () => {
  it('leaves every model and version of a mature source at the mature level', async () => {
    await seed();

    await migrateResourceToCollection({ id: SOURCE, collectionName: 'c' } as never);

    expect(await levels()).toEqual({
      models: [
        { id: SOURCE, nsfwLevel: 60 },
        { id: 101, nsfwLevel: 60 },
        { id: 102, nsfwLevel: 60 },
      ],
      versions: VERSIONS.map((id) => ({ id, nsfwLevel: 60 })),
    });
  });

  it('gives the civitai.com face only to the model holding its cover', async () => {
    await seed({ sfwCoverOnVersion: 11 });

    await migrateResourceToCollection({ id: SOURCE, collectionName: 'c' } as never);

    const created = vi.mocked(dbMock.dbWrite.model.create).mock.calls.map(([args]) => {
      const { data } = args as { data: Prisma.ModelUncheckedCreateInput };
      return [data.sfwName ?? null, data.sfwDescription ?? null, data.sfwCoverImageId ?? null];
    });
    expect(created).toEqual([
      ['Safe name', 'Safe text', 11],
      [null, null, null],
    ]);
    // The source no longer holds the cover's version, so its face moves with it.
    const sourceUpdate = vi
      .mocked(dbMock.dbWrite.model.update)
      .mock.calls.map(([args]) => (args as { where: { id: number }; data: object }).data)
      .find((data) => 'name' in data);
    expect(sourceUpdate).toMatchObject({
      sfwName: null,
      sfwDescription: null,
      sfwCoverImageId: null,
    });
  });

  it('keeps the face on the source when the cover stays with it', async () => {
    await seed({ sfwCoverOnVersion: 10 });

    await migrateResourceToCollection({ id: SOURCE, collectionName: 'c' } as never);

    const created = vi
      .mocked(dbMock.dbWrite.model.create)
      .mock.calls.map(([args]) => (args as { data: Prisma.ModelUncheckedCreateInput }).data);
    expect(created.map((data) => data.sfwName ?? null)).toEqual([null, null]);
    expect(created.map((data) => data.sfwCoverImageId ?? null)).toEqual([null, null]);
    const sourceUpdate = vi
      .mocked(dbMock.dbWrite.model.update)
      .mock.calls.map(([args]) => (args as { data: object }).data)
      .find((data) => 'name' in data);
    expect(sourceUpdate).not.toHaveProperty('sfwName');
  });
});
