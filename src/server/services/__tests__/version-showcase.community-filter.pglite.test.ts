import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The version showcase's community images, run through the cache's real lookup SQL against PGlite.
 * Each refused image sits beside a clean control, so a filter that drops everything fails too.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const gallery = vi.hoisted(() => ({ settings: null as unknown }));
vi.mock('~/server/services/model.service', () => ({
  getGallerySettingsByModelId: async () => gallery.settings,
}));
// The cache calls its lookup straight through, so what is tested is the lookup, not Redis.
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: (options: { lookupFn: (ids: number[], fromWrite?: boolean) => unknown }) => ({
    fetch: (ids: number[]) => options.lookupFn(ids, true),
    refresh: async () => undefined,
  }),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const { getVersionShowcases } = await import('../version-showcase.service');

const CREATOR = 1;
const MODEL = 10;
const VERSION = 100;
const PG = 1;
const R = 4;

let db: PGlite;
let nextId = 1000;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "User" (
      id int PRIMARY KEY, username text, settings jsonb, "bannedAt" timestamp, "deletedAt" timestamp
    );
    CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int,
      "publishedAt" timestamp, availability text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, name text, url text NOT NULL DEFAULT '',
      "nsfwLevel" int NOT NULL, width int, height int, hash text, type text NOT NULL DEFAULT 'image',
      metadata jsonb, meta jsonb, "hideMeta" boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      "blockedFor" text, "needsReview" text, "acceptableMinor" boolean NOT NULL DEFAULT false,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "scanJobs" jsonb,
      "modelRestricted" boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type text);
    CREATE TABLE "CreatorGalleryHiddenUser" ("creatorId" int, "userId" int);
    CREATE TABLE "ModelVersionShowcaseItem" (
      "modelVersionId" int, site text, "imageId" int, source text, position smallint,
      excluded boolean NOT NULL DEFAULT false, "removedByContributor" boolean NOT NULL DEFAULT false,
      "addedById" int, "createdAt" timestamp DEFAULT now()
    );
    INSERT INTO "User" (id, username) VALUES (${CREATOR}, 'creator');
    INSERT INTO "Model" VALUES (${MODEL}, ${CREATOR});
    INSERT INTO "ModelVersion" VALUES (${VERSION}, ${MODEL});
  `);
  // Integers typed as Prisma sends them.
  const INT4_OID = 23;
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray | Prisma.Sql,
    ...values: unknown[]
  ) => {
    const sql = Array.isArray(strings)
      ? Prisma.sql(strings as TemplateStringsArray, ...values)
      : (strings as Prisma.Sql);
    const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
    return (await db.query(sql.text, sql.values, { paramTypes })).rows;
  }) as never);
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
    { id: VERSION, modelId: MODEL },
  ] as never);
});
afterAll(() => db.close());

beforeEach(async () => {
  gallery.settings = null;
  await db.exec(`
    DELETE FROM "ModelVersionShowcaseItem"; DELETE FROM "Image"; DELETE FROM "Post";
    DELETE FROM "UserEngagement"; DELETE FROM "CreatorGalleryHiddenUser";
    DELETE FROM "User" WHERE id <> ${CREATOR};
  `);
});

/** A community image featured on the version and site; returns its id. */
async function featured({
  site = 'red',
  nsfwLevel = PG,
  user = {},
  image = {},
}: {
  site?: 'com' | 'red';
  nsfwLevel?: number;
  user?: { settings?: object; bannedAt?: string };
  image?: { tosViolation?: boolean; needsReview?: string };
} = {}) {
  const id = nextId++;
  await db.query(
    `INSERT INTO "User" (id, username, settings, "bannedAt") VALUES ($1, $2, $3, $4)`,
    [id, `author${id}`, user.settings ? JSON.stringify(user.settings) : null, user.bannedAt ?? null]
  );
  await db.query(
    `INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES ($1, $1, $2, now())`,
    [id, VERSION]
  );
  await db.query(
    `INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel", "tosViolation", "needsReview")
     VALUES ($1, $1, $1, $2, $3, $4)`,
    [id, nsfwLevel, image.tosViolation ?? false, image.needsReview ?? null]
  );
  await db.query(
    `INSERT INTO "ModelVersionShowcaseItem" ("modelVersionId", site, "imageId", source, "addedById")
     VALUES ($1, $2, $3, 'Community', $4)`,
    [VERSION, site, id, CREATOR]
  );
  return id;
}

async function served(site: 'com' | 'red' = 'red') {
  const showcase = (await getVersionShowcases([VERSION]))[VERSION];
  return showcase.community.filter((image) => image.site === site).map((image) => image.id);
}

describe('version showcase community filter', () => {
  it('serves a clean community image, credited to its author', async () => {
    const id = await featured();
    const showcase = (await getVersionShowcases([VERSION]))[VERSION];
    expect(showcase.community).toMatchObject([{ id, authorUsername: `author${id}` }]);
  });

  it("drops a banned author's image", async () => {
    const clean = await featured();
    await featured({ user: { bannedAt: '2026-01-01' } });
    expect(await served()).toEqual([clean]);
  });

  it('drops the image of an author who opted out', async () => {
    const clean = await featured();
    await featured({ user: { settings: { hideFromVersionShowcases: true } } });
    expect(await served()).toEqual([clean]);
  });

  it('drops an image when the creator and the author block each other, either way', async () => {
    const clean = await featured();
    const blockedByAuthor = await featured();
    const blockedByCreator = await featured();
    await db.query(`INSERT INTO "UserEngagement" VALUES ($1, $2, 'Block'), ($3, $4, 'Block')`, [
      blockedByAuthor,
      CREATOR,
      CREATOR,
      blockedByCreator,
    ]);
    expect(await served()).toEqual([clean]);
  });

  it('drops an author the creator hid from their galleries', async () => {
    const clean = await featured();
    const hidden = await featured();
    await db.query(`INSERT INTO "CreatorGalleryHiddenUser" VALUES ($1, $2)`, [CREATOR, hidden]);
    expect(await served()).toEqual([clean]);
  });

  it('serves only PG and PG-13 on civitai.com, and anything on civitai.red', async () => {
    const pg = await featured({ site: 'com', nsfwLevel: PG });
    await featured({ site: 'com', nsfwLevel: R });
    const redR = await featured({ site: 'red', nsfwLevel: R });
    expect(await served('com')).toEqual([pg]);
    expect(await served('red')).toEqual([redR]);
  });

  it('drops a TOS violation and an image waiting on review, like the owner showcase', async () => {
    const clean = await featured();
    await featured({ image: { tosViolation: true } });
    await featured({ image: { needsReview: 'minor' } });
    expect(await served()).toEqual([clean]);
  });

  it("applies the model's own gallery rules: hidden images and users, and the held level", async () => {
    const clean = await featured();
    const hiddenImage = await featured();
    const hiddenUser = await featured();
    await featured({ nsfwLevel: R });
    gallery.settings = {
      hiddenImages: { [VERSION]: [hiddenImage] },
      hiddenUsers: [{ id: hiddenUser }],
      sfwHeld: true,
      level: PG,
    };
    expect(await served()).toEqual([clean]);
  });

  it("drops a row the image's author removed", async () => {
    const clean = await featured();
    const removed = await featured();
    await db.query(
      `UPDATE "ModelVersionShowcaseItem" SET "removedByContributor" = true WHERE "imageId" = $1`,
      [removed]
    );
    expect(await served()).toEqual([clean]);
  });
});
